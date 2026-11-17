import { appendFile, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import '../stock-price-sync.js';
import { fetchDailyPrices, readActiveCycle, redact } from './test-stock-api.mjs';

const sync = globalThis.StockPriceSync;

export function completedThrough(now = new Date()) {
  return sync.completedThrough(now);
}

export function eligibleSessions(cycle, now = new Date()) {
  if (cycle.isFinalized) return [];
  const cutoff = completedThrough(now);
  return cycle.sessions.filter(s => (!s.locked || sync.price(s.price) === null) && s.dateIso <= cutoff);
}

export function makeFeed(cycle, previous, prices, now = new Date()) {
  const previousRows = sync.matches(cycle, previous) ? previous.sessions : [];
  const sessions = eligibleSessions(cycle, now).flatMap(slot => {
    const previousRow = previousRows.find(s => s.dateIso === slot.dateIso && s.sessionNumber === slot.sessionNumber);
    const previousValue = sync.price(previousRow?.price);
    // A locked empty Admin slot takes its first API value, then keeps that snapshot.
    const value = slot.locked && previousValue !== null ? previousValue
      : prices.has(slot.dateIso) ? sync.price(prices.get(slot.dateIso)) : previousValue;
    return value === null ? [] : [{ sessionNumber: slot.sessionNumber, dateIso: slot.dateIso, price: value }];
  });
  return {
    schemaVersion: 1, provider: 'Alpha Vantage', cycleId: cycle.id, ticker: cycle.ticker,
    cycleRevision: cycle.updatedAt || null, scheduleKey: sync.signature(cycle),
    updatedAt: now.toISOString(), sessions,
    dailyPrices: sync.dailyPricesFor(cycle.ticker, {
      schemaVersion: 1, ticker: cycle.ticker,
      dailyPrices: [...sync.dailyPricesFor(cycle.ticker, previous, now),
        ...[...prices].map(([dateIso, price]) => ({ dateIso, price }))]
    }, now)
  };
}

export async function updatePrices({
  directory = new URL('../', import.meta.url), apiKey = process.env.STOCK_API_KEY,
  now = new Date(), fetchImpl = globalThis.fetch, refreshPreviewCache = false
} = {}) {
  const historyPath = new URL('history_data.json', directory);
  const outputPath = new URL('market_prices.json', directory);
  const original = await readFile(historyPath, 'utf8');
  const payload = JSON.parse(original);
  if (!payload?.activeCycle) return { status: 'No active cycle. Kept the last price file.', changed: false };
  const cycle = readActiveCycle(payload);
  if (!cycle.id) throw new Error('The Admin active cycle needs an id.');
  const archived = Array.isArray(payload.history) && payload.history.some(record => record.id === cycle.id);
  if (archived && !refreshPreviewCache) {
    return { status: 'This cycle is already archived. Kept the price file unchanged.', changed: false };
  }
  const eligible = archived ? [] : eligibleSessions(cycle, now);
  if (!eligible.length && !refreshPreviewCache) {
    const cutoff = completedThrough(now);
    const locked = cycle.sessions.filter(s => s.locked && sync.price(s.price) !== null).length;
    const future = cycle.sessions.filter(s => s.dateIso > cutoff).length;
    return {
      status: `Skipped ${cycle.ticker}: no eligible sessions. Finalized: ${cycle.isFinalized ? 'Yes' : 'No'}. Locked with a price: ${locked}/${cycle.sessions.length}. Not yet closed: ${future}/${cycle.sessions.length}. No API request was made.`,
      changed: false
    };
  }

  let previous = null;
  try {
    previous = JSON.parse(await readFile(outputPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Cannot read the existing market_prices.json. Kept it unchanged.');
  }
  const prices = await fetchDailyPrices(apiKey, cycle.ticker, fetchImpl);
  const feed = makeFeed(archived ? { ...cycle, isFinalized: true } : cycle, previous, prices, now);
  // Updating the daily cache never revises a frozen published price snapshot.
  if (!eligible.length && sync.matches(cycle, previous)) feed.sessions = previous.sessions;
  if (await readFile(historyPath, 'utf8') !== original) {
    throw new Error('Admin JSON changed while fetching prices. Run the workflow again.');
  }
  if (!feed.sessions.length && (!refreshPreviewCache || !feed.dailyPrices.length)) {
    return { status: 'API has no prices for eligible completed sessions yet. Kept the last price file.', changed: false };
  }
  // Replace the file only after the complete response and cycle identity have been validated.
  const temporaryPath = new URL(`market_prices.json.${process.pid}.tmp`, directory);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(feed, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, outputPath);
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
  const latest = feed.sessions.map(s => s.dateIso).sort().at(-1) || 'none';
  const missing = eligible.filter(s => !feed.sessions.some(row => row.dateIso === s.dateIso)).length;
  const cycleStatus = eligible.length
    ? `${cycle.ticker}: saved ${feed.sessions.length}/${eligible.length} eligible session prices. Latest: ${latest}. Missing: ${missing}.`
    : `${cycle.ticker}: kept the cycle price snapshot unchanged (no eligible sessions).`;
  return {
    status: `${cycleStatus} Daily closing prices available for Admin previews: ${feed.dailyPrices.length}.`,
    changed: true, feed
  };
}

async function main() {
  let status;
  try {
    const result = await updatePrices({ refreshPreviewCache: process.env.REFRESH_PREVIEW_CACHE === 'true' });
    status = result.status;
    console.log(status);
  } catch (error) {
    status = `Price update failed: ${redact(error.message, process.env.STOCK_API_KEY?.trim())}`;
    console.error(status);
    process.exitCode = 1;
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Daily stock prices\n\n${status}\n\nSchedule: 07:00 Vietnam time, Tuesday–Saturday.\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
