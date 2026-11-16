import assert from 'node:assert/strict';
import test from 'node:test';
import { makeCycle } from './stock-test-support.mjs';
import { makeFeed } from './update-stock-prices.mjs';
import { createPage } from './browser-test-support.mjs';

const now = new Date('2026-11-16T00:00:00Z');
function scenario() {
  const cycle = makeCycle();
  const feed = makeFeed(cycle, null, new Map([[cycle.sessions[0].dateIso, 100], [cycle.sessions[1].dateIso, 110]]), now);
  return { history: { activeCycle: cycle, history: [] }, feed };
}

for (const filename of ['Nav_record_stock.html', 'admin_cycle_manager.html']) {
  test(`${filename}: loads 20 slots, fills matching API dates and averages only entered sessions`, async () => {
    const { history, feed } = scenario();
    const page = await createPage(filename, history, feed);
    await page.init();
    const state = page.snapshot();
    assert.equal(state.sessions.length, 20);
    assert.deepEqual(state.sessions.slice(0, 3).map(s => s.price), [100, 110, null]);
    assert.equal(page.run('calculateTask2Stats().avg'), 105);
    assert.equal(page.run('calculateTask2Stats().activeCount'), 2);
    assert(page.element('market-price-status').textContent.includes('2/20'));
    assert(page.intervals.some(timer => timer.milliseconds === 60_000));
    assert(page.data.requests.every(url => url.startsWith('./')));
    assert.equal((page.html.match(/<\/body>/g) || []).length, 1, 'Live Server must only see the main closing body');
  });

  test(`${filename}: open edits and clears take API prices on refresh and reload`, async () => {
    const { history, feed } = scenario();
    const page = await createPage(filename, history, feed);
    await page.init();
    page.element('input-price-0').handlers.input({ target: { value: '999' } });
    page.element('input-price-1').handlers.input({ target: { value: '' } });
    page.data.feed = makeFeed(history.activeCycle, feed, new Map([
      [history.activeCycle.sessions[0].dateIso, 120], [history.activeCycle.sessions[1].dateIso, 130], [history.activeCycle.sessions[2].dateIso, 140]
    ]), now);
    await page.run(filename.startsWith('Nav_') ? 'loadStaticJsonHistory()' : 'refreshAdminMarketPrices()');
    assert.deepEqual(page.snapshot().sessions.slice(0, 3).map(s => s.price), [120, 130, 140]);
    if (filename.startsWith('Nav_')) {
      const reloaded = await createPage(filename, history, page.data.feed, Object.fromEntries(page.storage));
      await reloaded.init();
      assert.deepEqual(reloaded.snapshot().sessions.slice(0, 3).map(s => s.price), [120, 130, 140]);
    }
  });

  test(`${filename}: API failure keeps the last displayed prices`, async () => {
    const { history, feed } = scenario();
    const page = await createPage(filename, history, feed);
    await page.init();
    page.data.offline = true;
    await page.run(filename.startsWith('Nav_') ? 'loadStaticJsonHistory()' : 'refreshAdminMarketPrices()');
    assert.deepEqual(page.snapshot().sessions.slice(0, 3).map(s => s.price), [100, 110, null]);
    assert(page.element('market-price-status').textContent.includes('keeping current data'));
  });

  test(`${filename}: the API restore button resumes automatic prices after a manual edit`, async () => {
    const { history, feed } = scenario();
    const page = await createPage(filename, history, feed);
    await page.init();
    page.element('input-price-0').handlers.input({ target: { value: '999' } });
    await page.element('btn-reset-market-prices').handlers.click();
    assert.equal(page.snapshot().sessions[0].price, 100);
    assert.equal(page.snapshot().sessions[0].manualOverride, false);
  });

  test(`${filename}: prices for another ticker, cycle, schedule or Admin revision are ignored`, async () => {
    for (const change of [{ ticker: 'AAPL' }, { cycleId: 'another-cycle' }, { scheduleKey: 'another-schedule' }, { cycleRevision: 'old-revision' }]) {
      const { history, feed } = scenario();
      const page = await createPage(filename, history, { ...feed, ...change });
      await page.init();
      assert(page.snapshot().sessions.every(s => s.price === null));
      assert.equal(page.run('calculateTask2Stats().avg'), null);
    }
  });

  test(`${filename}: a priced row lock protects values and unlocking resumes the API`, async () => {
    const { history, feed } = scenario();
    const page = await createPage(filename, history, feed);
    await page.init();
    page.element('input-price-0').handlers.input({ target: { value: '999' } });
    page.element('btn-lock-row-0').handlers.click();
    page.data.feed.sessions[0].price = 120;
    await page.run(filename.startsWith('Nav_') ? 'loadStaticJsonHistory()' : 'refreshAdminMarketPrices()');
    assert.equal(page.snapshot().sessions[0].price, 999);
    assert.equal(page.snapshot().sessions[0].locked, true);
    if (filename.startsWith('Nav_')) {
      const reloaded = await createPage(filename, history, page.data.feed, Object.fromEntries(page.storage));
      await reloaded.init();
      assert.equal(reloaded.snapshot().sessions[0].price, 999);
    }
    page.element('btn-lock-row-0').handlers.click();
    await page.run(filename.startsWith('Nav_') ? 'loadStaticJsonHistory()' : 'refreshAdminMarketPrices()');
    assert.equal(page.snapshot().sessions[0].price, 120);
  });

  test(`${filename}: an empty locked row is filled once, then stays locked at that price`, async () => {
    const { history, feed } = scenario();
    const page = await createPage(filename, history, feed);
    await page.init();
    page.element('btn-lock-row-2').handlers.click();
    page.data.feed.sessions.push({ ...history.activeCycle.sessions[2], price: 140 });
    await page.run(filename.startsWith('Nav_') ? 'loadStaticJsonHistory()' : 'refreshAdminMarketPrices()');
    assert.equal(page.snapshot().sessions[2].price, 140);
    assert.equal(page.snapshot().sessions[2].locked, true);
    page.data.feed.sessions[2].price = 240;
    await page.run(filename.startsWith('Nav_') ? 'loadStaticJsonHistory()' : 'refreshAdminMarketPrices()');
    assert.equal(page.snapshot().sessions[2].price, 140);
  });

  test(`${filename}: an open manual value is retained while its API date is absent`, async () => {
    const { history, feed } = scenario();
    const page = await createPage(filename, history, feed);
    await page.init();
    page.element('input-price-2').handlers.input({ target: { value: '999' } });
    await page.run(filename.startsWith('Nav_') ? 'loadStaticJsonHistory()' : 'refreshAdminMarketPrices()');
    assert.equal(page.snapshot().sessions[2].price, 999);
  });

  test(`${filename}: first install can wait for a missing price JSON without clearing Admin values`, async () => {
    const { history, feed } = scenario();
    history.activeCycle.sessions[0].price = 90;
    const page = await createPage(filename, history, feed);
    page.data.noFeed = true;
    await page.init();
    assert.equal(page.snapshot().sessions[0].price, 90);
    assert(!page.element('market-price-status').textContent.includes('keeping current data'));
    page.data.noFeed = false;
    await page.run(filename.startsWith('Nav_') ? 'loadStaticJsonHistory()' : 'refreshAdminMarketPrices()');
    assert.equal(page.snapshot().sessions[0].price, 100);
  });
}

test('User page: Admin locks and finalization override cached local edits', async () => {
  const { history, feed } = scenario();
  const page = await createPage('Nav_record_stock.html', history, feed);
  await page.init();
  page.element('input-price-0').handlers.input({ target: { value: '999' } });
  page.data.history.activeCycle.sessions[0].locked = true;
  page.data.history.activeCycle.sessions[0].price = 80;
  await page.run('loadStaticJsonHistory()');
  assert.equal(page.snapshot().sessions[0].price, 80);
  assert.equal(page.snapshot().sessions[0].masterLocked, true);
  assert(page.element('task2-table-body').children[0].innerHTML.includes('readonly'));
  page.data.history.activeCycle.isFinalized = true;
  page.data.history.activeCycle.sessions[1].price = 90;
  await page.run('loadStaticJsonHistory()');
  assert.equal(page.snapshot().finalized, true);
  assert.equal(page.snapshot().sessions[1].price, 90);
  assert.equal(page.element('btn-finalize-cycle').disabled, true);
  page.element('btn-finalize-cycle').handlers.click();
  assert.equal(page.snapshot().finalized, true);
  page.data.history.activeCycle.isFinalized = false;
  page.data.history.activeCycle.sessions[0].locked = false;
  await page.run('loadStaticJsonHistory()');
  assert.equal(page.snapshot().sessions[0].locked, false);
  assert.equal(page.snapshot().sessions[0].price, 100);
});

test('User page: local finalization freezes the draft through refresh and reload', async () => {
  const { history, feed } = scenario();
  const page = await createPage('Nav_record_stock.html', history, feed);
  await page.init();
  page.element('btn-finalize-cycle').handlers.click();
  page.data.feed.sessions[0].price = 200;
  await page.run('loadStaticJsonHistory()');
  assert.equal(page.snapshot().sessions[0].price, 100);
  const reloaded = await createPage('Nav_record_stock.html', history, page.data.feed, Object.fromEntries(page.storage));
  await reloaded.init();
  assert.equal(reloaded.snapshot().sessions[0].price, 100);
  assert.equal(reloaded.snapshot().finalized, true);
});

test('User page: archived Admin cycle disappears from active slots and remains in history', async () => {
  const { history, feed } = scenario();
  const page = await createPage('Nav_record_stock.html', history, feed);
  await page.init();
  page.data.history.history = [{ ...history.activeCycle, avgPrice: 105 }];
  page.data.history.activeCycle = null;
  await page.run('loadStaticJsonHistory()');
  assert.equal(page.snapshot().sessions.length, 0);
  assert.equal(page.element('task2-panel').classList.contains('hidden'), true);
  assert.equal(page.run('staticJsonHistory.length'), 1);
});

test('Admin page: finalize captures latest API values and archive freezes the same snapshot', async () => {
  const { history, feed } = scenario();
  const page = await createPage('admin_cycle_manager.html', history, feed);
  await page.init();
  page.data.feed = makeFeed(history.activeCycle, feed, new Map([[history.activeCycle.sessions[0].dateIso, 120]]), now);
  await page.element('btn-finalize-cycle').handlers.click();
  assert.equal(page.snapshot().finalized, true);
  let result = JSON.parse(page.run('JSON.stringify(buildFullJsonPackage())'));
  assert.equal(result.activeCycle.sessions[0].price, 120);
  assert.equal(result.activeCycle.avgPrice, 115);
  page.data.feed.sessions[0].price = 500;
  await page.run('refreshAdminMarketPrices()');
  assert.equal(page.snapshot().sessions[0].price, 120);
  await page.element('btn-save-history').handlers.click();
  result = JSON.parse(page.run('JSON.stringify(buildFullJsonPackage())'));
  assert.equal(result.history[0].avgPrice, 115);
  assert.equal(result.history[0].sessions[0].price, 120);
  assert(result.history[0].sessions.every(s => s.locked));
  assert.equal(result.activeCycle.isFinalized, true);
});

test('Admin page: saving an unfinalized cycle to history also stops automatic updates', async () => {
  const { history, feed } = scenario();
  const page = await createPage('admin_cycle_manager.html', history, feed);
  await page.init();
  await page.element('btn-save-history').handlers.click();
  assert.equal(page.snapshot().finalized, true);
  assert.equal(page.run('adminHistory[0].avgPrice'), 105);
});
