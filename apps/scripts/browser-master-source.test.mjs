import assert from 'node:assert/strict';
import test from 'node:test';
import { createPage } from './browser-test-support.mjs';
import { makeCycle } from './stock-test-support.mjs';
import { makeFeed } from './update-stock-prices.mjs';

const now = '2026-11-17T00:00:00Z';
const options = { now };

function scenario() {
  const cycle = makeCycle();
  cycle.sessions[0].price = 100;
  cycle.sessions[1].price = 110;
  const record = { ...structuredClone(cycle), id: 'committed-history', avgPrice: 80, savedAt: now };
  const history = { activeCycle: cycle, history: [record] };
  const feed = makeFeed(cycle, null, new Map(cycle.sessions.slice(0, 2).map(s => [s.dateIso, s.price])), new Date(now));
  return { history, feed };
}

async function newDraft(page, filename) {
  page.element('target-date-input').value = '2027-02-15';
  if (filename.startsWith('admin')) {
    page.element('target-date-input').handlers.change({ target: { value: '2027-02-15' } });
    await page.element('btn-apply-cycle').handlers.click();
  } else {
    page.run("handleDateChange('2027-02-15', false); executeLoadTask2();");
  }
  page.element('input-price-0').handlers.input({ target: { value: '777' } });
  page.element('btn-lock-row-0').handlers.click();
}

for (const filename of ['admin_cycle_manager.html', 'Nav_record_stock.html']) {
  test(`${filename}: reload selects the committed JSON cycle instead of a newly created local cycle`, async () => {
    const { history, feed } = scenario();
    const page = await createPage(filename, history, feed, {}, options);
    await page.init();
    await newDraft(page, filename);
    assert.notEqual(page.snapshot().meta.id, history.activeCycle.id);
    const reloaded = await createPage(filename, history, feed, Object.fromEntries(page.storage), options);
    await reloaded.init();
    assert.equal(reloaded.snapshot().meta.id, history.activeCycle.id);
    assert.equal(reloaded.snapshot().sessions[0].date?.slice(0, 10), history.activeCycle.startDate);
    assert.equal(reloaded.snapshot().sessions[0].price, 100);
    assert.equal(reloaded.snapshot().sessions[0].locked, false);
    assert.equal(reloaded.element('conflict-modal').classList.contains('hidden'), true);
    const records = JSON.parse(reloaded.run(filename.startsWith('admin')
      ? 'JSON.stringify(adminHistory)' : 'JSON.stringify(staticJsonHistory)'));
    assert.deepEqual(records, history.history);
  });

  test(`${filename}: an empty committed activeCycle cannot resurrect a local preview on reload`, async () => {
    const { history, feed } = scenario();
    const page = await createPage(filename, history, feed, {}, options);
    await page.init();
    await newDraft(page, filename);
    history.activeCycle = null;
    const reloaded = await createPage(filename, history, feed, Object.fromEntries(page.storage), options);
    await reloaded.init();
    assert.equal(reloaded.snapshot().meta, null);
    assert.equal(reloaded.snapshot().sessions.length, 0);
    assert.equal(reloaded.element('task2-panel').classList.contains('hidden'), true);
    assert(reloaded.element('history-container').innerHTML.includes('$80.00'));
  });

  test(`${filename}: offline recovery may use confirmed JSON but never a newly created local cycle`, async () => {
    const { history, feed } = scenario();
    const page = await createPage(filename, history, feed, {}, options);
    await page.init();
    await newDraft(page, filename);
    const reloaded = await createPage(filename, history, feed, Object.fromEntries(page.storage), options);
    reloaded.data.offline = true;
    await reloaded.init();
    assert.equal(reloaded.snapshot().meta.id, history.activeCycle.id);
    assert.equal(reloaded.snapshot().sessions[0].price, 100);
    assert(reloaded.element('history-container').innerHTML.includes('$80.00'));
  });
}

test('Admin reload restores JSON prices, locks and finalization even when the cycle ID has not changed', async () => {
  const { history, feed } = scenario();
  history.activeCycle.sessions[1].locked = true;
  const page = await createPage('admin_cycle_manager.html', history, feed, {}, options);
  await page.init();
  page.element('input-price-0').handlers.input({ target: { value: '777' } });
  page.element('btn-lock-row-0').handlers.click();
  page.element('btn-lock-row-1').handlers.click();
  page.element('input-price-1').handlers.input({ target: { value: '888' } });
  await page.element('btn-finalize-cycle').handlers.click();
  feed.sessions[0].price = 200;
  const reloaded = await createPage('admin_cycle_manager.html', history, feed, Object.fromEntries(page.storage), options);
  await reloaded.init();
  assert.deepEqual(reloaded.snapshot().sessions.slice(0, 2).map(s => [s.price, s.locked]), [[100, false], [110, true]]);
  assert.equal(reloaded.snapshot().finalized, false);
  await reloaded.element('btn-refresh-market-prices').handlers.click();
  assert.equal(reloaded.snapshot().sessions[0].price, 200, 'API values still apply on explicit refresh');
});

test('Admin ignores unpublished preview records left in the legacy localStorage key', async () => {
  const { history, feed } = scenario();
  const preview = structuredClone(history.activeCycle);
  preview.id = 'uncommitted-preview';
  preview.ticker = 'AAPL';
  const saved = { NAV_ADMIN_PRICE_DRAFT: JSON.stringify({
    schemaVersion: 1, publishedCycle: history.activeCycle, cycle: preview, marketPriceFeed: feed
  }) };
  const page = await createPage('admin_cycle_manager.html', history, feed, saved, options);
  await page.init();
  assert.equal(page.snapshot().meta.id, history.activeCycle.id);
  assert.equal(page.run('currentTicker'), 'ARM');
});

test('User reload uses the JSON ticker even if a cached published cycle has the same ID and another stock', async () => {
  const { history, feed } = scenario();
  const page = await createPage('Nav_record_stock.html', history, feed, {}, options);
  await page.init();
  const saved = Object.fromEntries(page.storage);
  const state = JSON.parse(saved.NAV_RECORD_STOCK_STATE);
  state.currentTicker = 'AAPL';
  state.publishedCycle.ticker = 'AAPL';
  state.sessions[0].price = 777;
  saved.NAV_RECORD_STOCK_STATE = JSON.stringify(state);
  const reloaded = await createPage('Nav_record_stock.html', history, feed, saved, options);
  await reloaded.init();
  assert.equal(reloaded.run('currentTicker'), 'ARM');
  assert.equal(reloaded.snapshot().sessions[0].price, 100);
});

test('User history keeps committed JSON records authoritative over local copies with the same ID', async () => {
  const { history, feed } = scenario();
  const page = await createPage('Nav_record_stock.html', history, feed, {}, options);
  await page.init();
  const local = { ...history.history[0], avgPrice: 777 };
  page.run(`userLocalHistory = ${JSON.stringify([local])}; saveStateToLocalStorage();`);
  const reloaded = await createPage('Nav_record_stock.html', history, feed, Object.fromEntries(page.storage), options);
  await reloaded.init();
  const record = JSON.parse(reloaded.run("JSON.stringify(mergedHistory.find(r => r.id === 'committed-history'))"));
  assert.equal(record.avgPrice, 80);
  assert.equal(record.isStatic, true);
});

test('Admin confirmed JSON cache cannot be changed by editing prices or saving uncommitted history', async () => {
  const { history, feed } = scenario();
  const page = await createPage('admin_cycle_manager.html', history, feed, {}, options);
  await page.init();
  page.element('input-price-0').handlers.input({ target: { value: '777' } });
  await page.element('btn-save-history').handlers.click();
  const cached = JSON.parse(page.storage.get('NAV_ADMIN_MASTER_SNAPSHOT'));
  assert.deepEqual(cached.payload, history);
  assert.equal(page.run('adminHistory.length'), history.history.length + 1);
});

test('Admin selecting a new date without Apply cannot mix preview dates into the active JSON package', async () => {
  const { history, feed } = scenario();
  const page = await createPage('admin_cycle_manager.html', history, feed, {}, options);
  await page.init();
  page.element('target-date-input').handlers.change({ target: { value: '2027-02-15' } });
  const output = JSON.parse(page.run('JSON.stringify(buildFullJsonPackage())'));
  assert.equal(output.activeCycle.id, history.activeCycle.id);
  assert.equal(output.activeCycle.startDate, history.activeCycle.startDate);
  assert.equal(output.activeCycle.endDate, history.activeCycle.endDate);
  assert.equal(output.activeCycle.year, history.activeCycle.year);
  await page.element('btn-save-history').handlers.click();
  const archived = JSON.parse(page.run(`JSON.stringify(adminHistory.find(r => r.id === '${history.activeCycle.id}'))`));
  assert.equal(archived.startDate, history.activeCycle.startDate);
  assert.equal(archived.endDate, history.activeCycle.endDate);
});

test('User offline recovery remembers a newly confirmed history even when active prices did not change', async () => {
  const { history, feed } = scenario();
  const page = await createPage('Nav_record_stock.html', history, feed, {}, options);
  await page.init();
  page.data.history.history[0].avgPrice = 90;
  await page.run('loadStaticJsonHistory()');
  const reloaded = await createPage('Nav_record_stock.html', history, feed, Object.fromEntries(page.storage), options);
  reloaded.data.offline = true;
  await reloaded.init();
  assert.equal(reloaded.run('staticJsonHistory[0].avgPrice'), 90);
});
