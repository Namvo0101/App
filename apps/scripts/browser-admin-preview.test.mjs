import assert from 'node:assert/strict';
import test from 'node:test';
import { createPage } from './browser-test-support.mjs';
import { makeCycle } from './stock-test-support.mjs';
import { makeFeed } from './update-stock-prices.mjs';

const now = '2026-11-17T00:00:00Z';
const filename = 'admin_cycle_manager.html';

async function scenario(legacy = false) {
  const cycle = makeCycle();
  const history = { activeCycle: cycle, history: [] };
  const prices = new Map(cycle.sessions.map((s, i) => [s.dateIso, 100 + i]));
  prices.set('2026-11-16', 150);
  const feed = makeFeed(cycle, null, prices, new Date(now));
  if (legacy) delete feed.dailyPrices;
  else feed.dailyPrices = [...prices].map(([dateIso, price]) => ({ dateIso, price }));
  const page = await createPage(filename, history, feed, {}, { now });
  await page.init();
  return { page, history, feed };
}

async function select(page, date = '2026-11-17') {
  page.element('target-date-input').value = date;
  await page.element('target-date-input').handlers.change({ target: { value: date } });
}
async function apply(page, date = '2026-11-17') {
  await select(page, date);
  return page.element('btn-apply-cycle').handlers.click();
}

test('Admin preview: Apply fills a new unpublished cycle by ticker and date without committing it', async () => {
  const { page, history } = await scenario();
  const original = JSON.stringify(page.data.history);
  await apply(page);
  assert.notEqual(page.snapshot().meta.id, history.activeCycle.id);
  assert.equal(page.snapshot().sessions[0].price, 101);
  assert.equal(page.snapshot().sessions.at(-1).price, 150);
  assert.equal(page.run('calculateTask2Stats().avg'), 112);
  assert.equal(page.element('price-kind-0')['data-price-kind'], 'official');
  assert(page.element('market-price-status').textContent.includes('Preview'));
  assert.equal(JSON.stringify(page.data.history), original);
  assert(page.data.requests.every(url => url.startsWith('./')));
});

test('Admin preview: reload returns to committed JSON and drops the uncommitted cycle, locks and estimates', async () => {
  const { page, history, feed } = await scenario();
  await apply(page, '2026-11-18');
  page.element('input-price-0').handlers.input({ target: { value: '999' } });
  page.element('btn-lock-row-0').handlers.click();
  page.element('input-price-19').handlers.input({ target: { value: '250' } });
  const id = page.snapshot().meta.id;
  const reloaded = await createPage(filename, history, feed, Object.fromEntries(page.storage), { now });
  await reloaded.init();
  assert.notEqual(reloaded.snapshot().meta.id, id);
  assert.equal(reloaded.snapshot().meta.id, history.activeCycle.id);
  assert(reloaded.snapshot().sessions.every(s => s.price === null && !s.locked));
  assert.equal(reloaded.element('price-kind-0')['data-price-kind'], 'available');
  await reloaded.element('btn-refresh-market-prices').handlers.click();
  assert.equal(reloaded.snapshot().sessions[0].price, 100);
});

test('Admin preview: a legacy feed can still fill overlapping dates in a new cycle', async () => {
  const { page } = await scenario(true);
  await apply(page);
  assert.equal(page.snapshot().sessions[0].price, 101);
  assert.equal(page.snapshot().sessions.at(-1).price, null);
});

test('Admin preview: API cache for another stock cannot fill the new draft', async () => {
  const { page } = await scenario();
  page.element('input-stock-ticker').handlers.input({ target: { value: 'AAPL' } });
  await apply(page);
  assert(page.snapshot().sessions.every(s => s.price === null));
});

test('Admin preview: a cached row for a session that has not closed is ignored', async () => {
  const { page } = await scenario();
  page.data.feed.dailyPrices.push({ dateIso: '2026-11-17', price: 999 });
  await apply(page, '2026-11-18');
  assert.equal(page.snapshot().sessions.at(-1).dateIso, '2026-11-17');
  assert.equal(page.snapshot().sessions.at(-1).price, null);
});

test('Admin preview: input during a pending Apply price request remains editable and is preserved', async () => {
  const { page } = await scenario();
  await select(page);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  page.data.beforeResponse = url => url.startsWith('./market_prices.json') ? gate : undefined;
  const pending = page.element('btn-apply-cycle').handlers.click();
  page.element('input-price-0').handlers.input({ target: { value: '999' } });
  release();
  await pending;
  assert.equal(page.snapshot().sessions[0].price, 999);
  assert.equal(page.run('calculateTask2Stats().activeCount'), 20);
});

test('Admin preview: a queued Apply refresh preserves edits made while an older cycle request finishes', async () => {
  const { page } = await scenario();
  await select(page);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  page.data.beforeResponse = url => url.startsWith('./market_prices.json') ? gate : undefined;
  const oldRefresh = page.run('refreshAdminMarketPrices()');
  const pendingApply = page.element('btn-apply-cycle').handlers.click();
  page.element('input-price-0').handlers.input({ target: { value: '999' } });
  release();
  await oldRefresh;
  await pendingApply;
  assert.equal(page.snapshot().sessions[0].price, 999);
  assert.equal(page.snapshot().sessions.at(-1).price, 150);
  assert.equal(page.run('calculateTask2Stats().activeCount'), 20);
});
