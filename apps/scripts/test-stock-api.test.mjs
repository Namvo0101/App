import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildReport, fetchDailyPrices, readActiveCycle, redact } from './test-stock-api.mjs';

const historyUrl = new URL('../history_data.json', import.meta.url);
const history = await readFile(historyUrl, 'utf8');
const cycle = readActiveCycle(JSON.parse(history));
const key = 'sample-key-for-offline-tests';
const data = {
  'Meta Data': { '2. Symbol': cycle.ticker },
  'Time Series (Daily)': {
    [cycle.sessions[1].dateIso]: { '4. close': '110.25' },
    [cycle.sessions[0].dateIso]: { '4. close': '100.50' }
  }
};
const response = payload => async () => ({ ok: true, json: async () => payload });

test('Matches prices by trading date and leaves missing slots empty', async () => {
  const prices = await fetchDailyPrices(key, cycle.ticker, async url => {
    assert.equal(url.searchParams.get('function'), 'TIME_SERIES_DAILY');
    assert.equal(url.searchParams.get('symbol'), cycle.ticker);
    assert.equal(url.searchParams.get('outputsize'), 'compact');
    assert.equal(url.searchParams.get('apikey'), key);
    return { ok: true, json: async () => data };
  });
  const report = buildReport(cycle, prices);
  assert.equal(report.matchedCount, 2);
  assert(report.summary.includes(`| 1 | ${cycle.sessions[0].dateIso} | 100.50 |`));
  assert(report.summary.includes(`| 2 | ${cycle.sessions[1].dateIso} | 110.25 |`));
  assert(report.summary.includes(`| 3 | ${cycle.sessions[2].dateIso} | Not available |`));
});

test('An API success outside the cycle produces a report with zero matches', async () => {
  const report = buildReport(cycle, new Map([['2000-01-03', 42]]));
  assert.equal(report.matchedCount, 0);
  assert(report.summary.includes('**0/20**'));
});

test('Missing secret fails before any network request', async () => {
  let called = false;
  await assert.rejects(fetchDailyPrices('', cycle.ticker, () => { called = true; }), /Missing STOCK_API_KEY/);
  assert.equal(called, false);
});

test('The command exits with status 1 and a useful message when the secret is absent', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./test-stock-api.mjs', import.meta.url))], {
    env: { ...process.env, STOCK_API_KEY: '', GITHUB_STEP_SUMMARY: '' },
    encoding: 'utf8'
  });
  assert.equal(result.status, 1);
  assert(result.stderr.includes('Missing STOCK_API_KEY'));
});

test('HTTP 200 API errors are failures and keys are redacted', async () => {
  for (const field of ['Error Message', 'Note', 'Information']) {
    await assert.rejects(fetchDailyPrices(key, cycle.ticker, response({ [field]: `Error for ${key}` })), error => {
      assert(!error.message.includes(key));
      return error.message.includes('[REDACTED]');
    });
  }
  assert.equal(redact('a+b a%2Bb', 'a+b'), '[REDACTED] [REDACTED]');
});

test('Rejects network failures, HTTP errors and malformed JSON without leaking URLs', async () => {
  await assert.rejects(fetchDailyPrices(key, cycle.ticker, async () => { throw new Error(`url?apikey=${key}`); }), /Could not reach Alpha Vantage/);
  await assert.rejects(fetchDailyPrices(key, cycle.ticker, async () => ({ ok: false, status: 429 })), /HTTP 429/);
  await assert.rejects(fetchDailyPrices(key, cycle.ticker, async () => ({ ok: true, json: async () => { throw new Error('Invalid JSON'); } })), /valid JSON/);
});

test('Rejects wrong tickers, missing series and invalid prices', async () => {
  await assert.rejects(fetchDailyPrices(key, cycle.ticker, response({ ...data, 'Meta Data': { '2. Symbol': 'WRONG' } })), /requested ticker/);
  await assert.rejects(fetchDailyPrices(key, cycle.ticker, response({ ...data, 'Time Series (Daily)': {} })), /daily prices/);
  for (const price of [null, '', 'NaN', -1]) {
    const payload = { ...data, 'Time Series (Daily)': { '2026-01-02': { '4. close': price } } };
    await assert.rejects(fetchDailyPrices(key, cycle.ticker, response(payload)), /invalid date or closing price/);
  }
});

test('Rejects duplicate slots and invalid calendar dates in Admin JSON', () => {
  const payload = JSON.parse(history);
  payload.activeCycle.sessions[1].dateIso = payload.activeCycle.sessions[0].dateIso;
  assert.throws(() => readActiveCycle(payload), /unique dateIso/);
  payload.activeCycle.sessions[1].dateIso = '2026-02-30';
  assert.throws(() => readActiveCycle(payload), /unique dateIso/);
});

test('Reading and reporting preserves Admin locks, finalization and history', async () => {
  const payload = JSON.parse(history);
  const original = JSON.stringify(payload);
  const finalizedCycle = { ...readActiveCycle(payload), isFinalized: true };
  const report = buildReport(finalizedCycle, await fetchDailyPrices(key, cycle.ticker, response(data)));
  assert(report.summary.includes('Admin finalized: **Yes**'));
  assert.equal(JSON.stringify(payload), original);
  assert.equal(await readFile(historyUrl, 'utf8'), history);
});
