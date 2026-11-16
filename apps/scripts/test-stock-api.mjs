import { appendFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function isDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0, 10) === value;
}

export function readActiveCycle(payload) {
  const cycle = payload?.activeCycle;
  if (!cycle || typeof cycle.ticker !== 'string' || !cycle.ticker.trim()) {
    throw new Error('history_data.json needs an activeCycle with a ticker.');
  }
  const ticker = cycle.ticker.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9.\-^:]{0,23}$/.test(ticker)) {
    throw new Error('The active cycle ticker is not valid.');
  }
  if (!Array.isArray(cycle.sessions) || cycle.sessions.length !== 20) {
    throw new Error('The Admin active cycle must contain exactly 20 sessions.');
  }
  const dates = cycle.sessions.map(session => session?.dateIso);
  if (!dates.every(isDate) || new Set(dates).size !== 20) {
    throw new Error('Each active session needs a unique dateIso in YYYY-MM-DD format.');
  }
  return { ...cycle, ticker };
}

export function redact(message, apiKey) {
  let result = String(message);
  if (apiKey) {
    for (const value of [apiKey, encodeURIComponent(apiKey)]) {
      result = result.replaceAll(value, '[REDACTED]');
    }
  }
  return result.replace(/[\r\n]/g, ' ').slice(0, 1000);
}

export async function fetchDailyPrices(apiKey, ticker, fetchImpl = globalThis.fetch) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new Error('Missing STOCK_API_KEY. Add it as a repository Actions secret.');
  }
  const key = apiKey.trim();
  const url = new URL('https://www.alphavantage.co/query');
  url.search = new URLSearchParams({
    function: 'TIME_SERIES_DAILY', symbol: ticker,
    outputsize: 'compact', datatype: 'json', apikey: key
  }).toString();

  let response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
  } catch {
    // Fetch errors can contain the request URL, so do not print the raw exception.
    throw new Error('Could not reach Alpha Vantage within 30 seconds. Please run the test again later.');
  }
  if (!response.ok) {
    throw new Error(`Alpha Vantage returned HTTP ${response.status}.`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error('Alpha Vantage did not return valid JSON.');
  }
  for (const field of ['Error Message', 'Note', 'Information']) {
    if (payload?.[field]) {
      throw new Error(`Alpha Vantage: ${redact(payload[field], key)}`);
    }
  }
  const symbol = payload?.['Meta Data']?.['2. Symbol'];
  if (typeof symbol !== 'string' || symbol.toUpperCase() !== ticker) {
    throw new Error('The API response does not identify the requested ticker.');
  }
  const series = payload?.['Time Series (Daily)'];
  if (!series || typeof series !== 'object' || Array.isArray(series) || !Object.keys(series).length) {
    throw new Error('The API response does not contain daily prices.');
  }

  const prices = new Map();
  for (const [date, bar] of Object.entries(series)) {
    const raw = bar?.['4. close'];
    const price = Number(raw);
    if (!isDate(date) || !['string', 'number'].includes(typeof raw)
      || String(raw).trim() === '' || !Number.isFinite(price) || price < 0) {
      throw new Error('The API response contains an invalid date or closing price.');
    }
    prices.set(date, price);
  }
  return prices;
}

export function buildReport(cycle, prices) {
  const dates = [...prices.keys()].sort();
  const matching = cycle.sessions.filter(session => prices.has(session.dateIso));
  const lines = [
    '## Stock API test', '',
    `- Symbol: **${cycle.ticker}**`,
    '- Provider: Alpha Vantage / TIME_SERIES_DAILY / raw daily close',
    `- Dates returned by API: **${dates[0]} → ${dates.at(-1)}** (${dates.length} sessions)`,
    `- Admin cycle sessions with an API price: **${matching.length}/20**`,
    `- Admin finalized: **${cycle.isFinalized ? 'Yes' : 'No'}**`, '',
    '| Session | Trading date | API close (USD) | Admin row locked |',
    '| --- | --- | ---: | --- |'
  ];
  cycle.sessions.forEach((session, index) => {
    const price = prices.has(session.dateIso) ? prices.get(session.dateIso).toFixed(2) : 'Not available';
    lines.push(`| ${index + 1} | ${session.dateIso} | ${price} | ${session.locked ? 'Yes' : 'No'} |`);
  });
  lines.push('', 'This is a read-only connectivity test. Admin locks, prices, finalization, history and the website are unchanged.');
  if (matching.length < 20) {
    lines.push('', 'Missing prices can be future sessions, provider delays or dates outside the latest 100 daily records. A missing price is not converted to zero.');
  }
  return { summary: `${lines.join('\n')}\n`, matchedCount: matching.length };
}

async function main() {
  if (!process.env.STOCK_API_KEY?.trim()) throw new Error('Missing STOCK_API_KEY. Add it as a repository Actions secret.');
  const payload = JSON.parse(await readFile(new URL('../history_data.json', import.meta.url), 'utf8'));
  const cycle = readActiveCycle(payload);
  const prices = await fetchDailyPrices(process.env.STOCK_API_KEY, cycle.ticker);
  const report = buildReport(cycle, prices);
  console.log(report.summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, report.summary);
  }
  if (!report.matchedCount) {
    console.log('::warning::API connection succeeded, but no returned dates match the Admin cycle. Check the report.');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(async error => {
    const message = redact(error.message, process.env.STOCK_API_KEY?.trim());
    console.error(`Stock API test failed: ${message}`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Stock API test failed\n\n${message}\n`).catch(() => {});
    }
    process.exitCode = 1;
  });
}
