import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import '../stock-price-sync.js';
import { completedThrough, eligibleSessions, makeFeed, updatePrices } from './update-stock-prices.mjs';
import { makeCycle, apiResponse } from './stock-test-support.mjs';

const now = new Date('2026-11-16T00:00:00Z');
const key = 'offline-test-key';
const sync = globalThis.StockPriceSync;

test('Completed-session cutoff follows New York summer and standard time', () => {
  assert.equal(completedThrough(new Date('2026-07-10T19:59:00Z')), '2026-07-09');
  assert.equal(completedThrough(new Date('2026-07-10T20:00:00Z')), '2026-07-10');
  assert.equal(completedThrough(new Date('2026-11-13T20:59:00Z')), '2026-11-12');
  assert.equal(completedThrough(new Date('2026-11-13T21:00:00Z')), '2026-11-13');
});

test('Completed open slots take API prices even with legacy manual flags', () => {
  const cycle = makeCycle();
  cycle.sessions[0].locked = true;
  cycle.sessions[0].price = 90;
  cycle.sessions[1].manualOverride = true;
  cycle.sessions[1].price = 999;
  const feed = makeFeed(cycle, null, new Map(cycle.sessions.map(s => [s.dateIso, 100 + s.sessionNumber])), new Date('2026-10-21T22:00:00Z'));
  assert.equal(feed.sessions.length, 2);
  assert.equal(feed.sessions[0].dateIso, cycle.sessions[1].dateIso);
  assert.equal(feed.sessions[0].price, 102);
  assert.equal(eligibleSessions({ ...cycle, isFinalized: true }, now).length, 0);
});

test('Missing API dates retain prior prices for the same cycle and revision', () => {
  const cycle = makeCycle();
  const first = makeFeed(cycle, null, new Map([[cycle.sessions[0].dateIso, 100]]), now);
  const next = makeFeed(cycle, first, new Map([[cycle.sessions[1].dateIso, 110]]), now);
  assert.deepEqual(next.sessions.map(s => s.price), [100, 110]);
  for (const change of [{ ticker: 'AAPL' }, { id: 'different' }, { updatedAt: '2026-11-15T00:00:00Z' }]) {
    assert.equal(makeFeed({ ...cycle, ...change }, first, new Map(), now).sessions.length, 0);
  }
  const movedDate = structuredClone(cycle);
  movedDate.sessions[0].dateIso = '2026-10-18';
  assert(!sync.matches(movedDate, first));
});

test('API wins in open/empty rows; priced locks and finalization protect values', () => {
  const cycle = makeCycle();
  const slot = cycle.sessions[0];
  const feed = makeFeed(cycle, null, new Map([[slot.dateIso, 100]]), now);
  assert.equal(sync.mergeSession(cycle, slot, { price: null, manualOverride: false }, feed).price, 100);
  assert.equal(sync.mergeSession(cycle, slot, { price: null, manualOverride: true }, feed).price, 100);
  assert.equal(sync.mergeSession(cycle, slot, { price: 999, manualOverride: true }, feed).price, 100);
  assert.equal(sync.mergeSession(cycle, slot, { price: 999, locked: true }, feed).price, 999);
  assert.equal(sync.mergeSession(cycle, slot, { price: null, locked: true }, feed).price, 100);
  assert.equal(sync.mergeSession(cycle, { ...slot, locked: true }, null, feed).price, 100);
  assert.equal(sync.mergeSession(cycle, { ...slot, price: 80, locked: true }, { price: 999, manualOverride: true }, feed).price, 80);
  assert.equal(sync.mergeSession({ ...cycle, isFinalized: true }, { ...slot, price: 90 }, null, feed).price, 90);
  assert.equal(sync.mergeSession(cycle, { ...slot, price: 70, manualOverride: true }, null, feed).price, 100);
  const withoutApi = { ...feed, sessions: [] };
  assert.equal(sync.mergeSession(cycle, slot, { price: 999 }, withoutApi).price, 999);
  assert.equal(sync.mergeSession(cycle, { ...slot, price: 70 }, { price: null }, withoutApi).price, null);
  const unlocked = sync.mergeSession(cycle, slot, { price: 80, locked: true, masterLocked: true }, feed);
  assert.equal(unlocked.locked, false);
  assert.equal(unlocked.price, 100);
  assert.equal(sync.mergeSession({ ...cycle, userFinalized: true }, slot, { price: 999 }, feed).price, 999);
});

test('A locked blank Admin row takes its first API price and keeps that snapshot', () => {
  const cycle = makeCycle();
  cycle.sessions[0].locked = true;
  const first = makeFeed(cycle, null, new Map([[cycle.sessions[0].dateIso, 100]]), now);
  assert.equal(first.sessions[0].price, 100);
  const next = makeFeed(cycle, first, new Map([[cycle.sessions[0].dateIso, 200]]), now);
  assert.equal(next.sessions[0].price, 100);
  assert.equal(sync.mergeSession(cycle, cycle.sessions[0], null, next).locked, true);
});

async function withFiles(callback) {
  const folder = await mkdtemp(join(tmpdir(), 'nav-stock-test-'));
  const directory = pathToFileURL(`${folder}/`);
  const cycle = makeCycle();
  const payload = { activeCycle: cycle, history: [{ id: 'old', avgPrice: 42 }] };
  const history = `${JSON.stringify(payload, null, 2)}\n`;
  await writeFile(new URL('history_data.json', directory), history);
  const old = JSON.stringify({ schemaVersion: 1, cycleId: null, sessions: [] });
  await writeFile(new URL('market_prices.json', directory), old);
  try { await callback({ directory, cycle, payload, history, old }); }
  finally {
    // mkdtemp created this exact child of the OS temp directory for this test only.
    assert.equal(join(tmpdir(), folder.slice(tmpdir().length + 1)), folder);
    await rm(folder, { recursive: true, force: true });
  }
}

test('Updater writes API prices atomically while leaving all Admin data unchanged', async () => {
  await withFiles(async ({ directory, cycle, history }) => {
    let calls = 0;
    const result = await updatePrices({ directory, apiKey: key, now, fetchImpl: async () => {
      calls++;
      return { ok: true, json: async () => apiResponse(cycle, [[cycle.sessions[0].dateIso, 100], [cycle.sessions[1].dateIso, 110]]) };
    } });
    assert.equal(calls, 1);
    assert(result.changed);
    const saved = JSON.parse(await readFile(new URL('market_prices.json', directory), 'utf8'));
    assert.equal(saved.sessions.length, 2);
    assert.equal(saved.cycleId, cycle.id);
    assert.equal(await readFile(new URL('history_data.json', directory), 'utf8'), history);
  });
});

test('No active cycle, finalized cycles and locked cycles make no API requests', async () => {
  await withFiles(async ({ directory, payload, old }) => {
    for (const activeCycle of [null, { ...payload.activeCycle, isFinalized: true }, {
      ...payload.activeCycle, sessions: payload.activeCycle.sessions.map(s => ({ ...s, price: 100, locked: true }))
    }]) {
      await writeFile(new URL('history_data.json', directory), JSON.stringify({ ...payload, activeCycle }));
      let called = false;
      const result = await updatePrices({ directory, apiKey: key, now, fetchImpl: () => { called = true; } });
      assert.equal(result.changed, false);
      assert.equal(called, false);
      if (activeCycle) {
        assert(result.status.includes(`Finalized: ${activeCycle.isFinalized ? 'Yes' : 'No'}`));
        assert(result.status.includes('No API request was made'));
        if (activeCycle.sessions.every(s => s.locked)) assert(result.status.includes('Locked with a price: 20/20'));
      }
      assert.equal(await readFile(new URL('market_prices.json', directory), 'utf8'), old);
    }
  });
});

test('An archived active ID is not fetched even with a legacy unfinalized flag', async () => {
  await withFiles(async ({ directory, payload }) => {
    payload.history.push({ id: payload.activeCycle.id });
    await writeFile(new URL('history_data.json', directory), JSON.stringify(payload));
    let called = false;
    const result = await updatePrices({ directory, apiKey: key, now, fetchImpl: () => { called = true; } });
    assert.equal(called, false);
    assert(result.status.includes('already archived'));
  });
});

test('API errors, missing dates and an Admin change during fetch preserve existing JSON', async () => {
  await withFiles(async ({ directory, cycle, old }) => {
    await assert.rejects(updatePrices({ directory, apiKey: key, now, fetchImpl: async () => ({ ok: true, json: async () => ({ Note: 'Rate limit' }) }) }), /Rate limit/);
    assert.equal(await readFile(new URL('market_prices.json', directory), 'utf8'), old);
    const absent = await updatePrices({ directory, apiKey: key, now, fetchImpl: async () => ({ ok: true, json: async () => apiResponse(cycle, [['2000-01-03', 1]]) }) });
    assert.equal(absent.changed, false);
    await assert.rejects(updatePrices({ directory, apiKey: key, now, fetchImpl: async () => {
      await writeFile(new URL('history_data.json', directory), JSON.stringify({ activeCycle: { ...cycle, isFinalized: true }, history: [] }));
      return { ok: true, json: async () => apiResponse(cycle, [[cycle.sessions[0].dateIso, 100]]) };
    } }), /Admin JSON changed/);
    assert.equal(await readFile(new URL('market_prices.json', directory), 'utf8'), old);
  });
});
