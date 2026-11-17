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
  test(`${filename}: badges distinguish API closing prices, estimates and empty slots in both languages`, async () => {
    const { history, feed } = scenario();
    const page = await createPage(filename, history, feed);
    await page.init();
    assert.equal(page.element('price-kind-0')['data-price-kind'], 'official');
    assert(page.element('price-kind-0').innerHTML.includes('Official'));
    assert.equal(page.element('price-kind-19')['data-price-kind'], 'empty');
    page.element('input-price-19').handlers.input({ target: { value: '150' } });
    assert.equal(page.element('price-kind-19')['data-price-kind'], 'estimate');
    assert(page.element('price-kind-19').innerHTML.includes('Estimate'));
    page.run("setLanguage('vi')");
    assert(page.element('price-kind-0').innerHTML.includes('Chính thức'));
    assert(page.element('price-kind-19').innerHTML.includes('Dự đoán'));
    assert.equal(page.run('calculateTask2Stats().avg'), 120);
  });

  test(`${filename}: editing an official value shows a manual price with an API reference immediately`, async () => {
    const { history, feed } = scenario();
    const page = await createPage(filename, history, feed);
    await page.init();
    const requestsBefore = page.data.requests.length;
    page.element('input-price-0').handlers.input({ target: { value: '160' } });
    assert.equal(page.element('price-kind-0')['data-price-kind'], 'manual');
    assert(page.element('price-kind-0').innerHTML.includes('API close: $100.00'));
    page.element('input-price-0').handlers.input({ target: { value: '100' } });
    assert.equal(page.element('price-kind-0')['data-price-kind'], 'official');
    page.element('input-price-0').handlers.input({ target: { value: '' } });
    assert.equal(page.element('price-kind-0')['data-price-kind'], 'available');
    assert(page.element('price-kind-0').innerHTML.includes('Closing price available'));
    assert.equal(page.data.requests.length, requestsBefore);
  });

  test(`${filename}: matching API data changes estimates to official prices after an explicit refresh`, async () => {
    const { history, feed } = scenario();
    const page = await createPage(filename, history, feed);
    await page.init();
    page.element('input-price-2').handlers.input({ target: { value: '150' } });
    assert.equal(page.element('price-kind-2')['data-price-kind'], 'estimate');
    page.data.feed.sessions.push({ ...history.activeCycle.sessions[2], price: 140 });
    await page.run(filename.startsWith('Nav_') ? 'loadStaticJsonHistory()' : 'refreshAdminMarketPrices()');
    assert.equal(page.snapshot().sessions[2].price, 140);
    assert.equal(page.element('price-kind-2')['data-price-kind'], 'official');
  });

  test(`${filename}: a locked estimate keeps its value when an API close arrives and its badge updates`, async () => {
    const { history, feed } = scenario();
    const page = await createPage(filename, history, feed);
    await page.init();
    page.element('input-price-2').handlers.input({ target: { value: '150' } });
    page.element('btn-lock-row-2').handlers.click();
    page.data.feed.sessions.push({ ...history.activeCycle.sessions[2], price: 140 });
    const refresh = filename.startsWith('Nav_') ? 'loadStaticJsonHistory()' : 'refreshAdminMarketPrices()';
    await page.run(refresh);
    assert.equal(page.snapshot().sessions[2].price, 150);
    assert.equal(page.element('price-kind-2')['data-price-kind'], 'manual');
    assert(page.element('price-kind-2').innerHTML.includes('API close: $140.00'));
    page.data.feed.sessions[2].price = 145;
    await page.run(refresh);
    assert.equal(page.snapshot().sessions[2].price, 150);
    assert(page.element('price-kind-2').innerHTML.includes('API close: $145.00'));
    const reloaded = await createPage(filename, history, page.data.feed, Object.fromEntries(page.storage));
    await reloaded.init();
    assert.equal(reloaded.snapshot().sessions[2].price, 150);
    assert.equal(reloaded.element('price-kind-2')['data-price-kind'], 'manual');
  });

  test(`${filename}: unrelated or invalid API rows cannot mark a manual price as official`, async () => {
    for (const change of [{ ticker: 'AAPL' }, { cycleRevision: 'old-revision' }, { scheduleKey: 'old-schedule' }, { cycleId: 'old-cycle' }]) {
      const { history, feed } = scenario();
      const page = await createPage(filename, history, { ...feed, ...change });
      await page.init();
      page.element('input-price-0').handlers.input({ target: { value: '100' } });
      assert.equal(page.element('price-kind-0')['data-price-kind'], 'estimate');
    }
    for (const apiPrice of [null, '', -1, 'invalid']) {
      const { history, feed } = scenario();
      feed.sessions[0].price = apiPrice;
      const page = await createPage(filename, history, feed);
      await page.init();
      page.element('input-price-0').handlers.input({ target: { value: '100' } });
      assert.equal(page.element('price-kind-0')['data-price-kind'], 'estimate');
    }
  });

  test(`${filename}: cached API verification survives an offline reload`, async () => {
    const { history, feed } = scenario();
    const page = await createPage(filename, history, feed);
    await page.init();
    const reloaded = await createPage(filename, history, feed, Object.fromEntries(page.storage));
    reloaded.data.offline = true;
    await reloaded.init();
    assert.equal(reloaded.element('price-kind-0')['data-price-kind'], 'official');
    assert(reloaded.element('price-kind-0').innerHTML.includes('previously loaded data'));
  });

  test(`${filename}: pasting and clearing prices update badges without waiting for a refresh`, async () => {
    const { history, feed } = scenario();
    const page = await createPage(filename, history, feed);
    await page.init();
    page.element('input-price-0').handlers.paste({
      clipboardData: { getData: () => '160\n110\n150' }, preventDefault() {}
    });
    assert.equal(page.element('price-kind-0')['data-price-kind'], 'manual');
    assert.equal(page.element('price-kind-1')['data-price-kind'], 'official');
    assert.equal(page.element('price-kind-2')['data-price-kind'], 'estimate');
    page.element('btn-clear-task2').handlers.click();
    assert.equal(page.element('price-kind-0')['data-price-kind'], 'available');
    assert.equal(page.element('price-kind-2')['data-price-kind'], 'empty');
  });

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
    assert.equal(page.intervals.length, 0, 'prices only refresh on load or an explicit update');
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
    const reloaded = await createPage(filename, history, page.data.feed, Object.fromEntries(page.storage));
    await reloaded.init();
    assert.deepEqual(reloaded.snapshot().sessions.slice(0, 3).map(s => s.price), [120, 130, 140]);
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
    const reloaded = await createPage(filename, history, page.data.feed, Object.fromEntries(page.storage));
    await reloaded.init();
    assert.equal(reloaded.snapshot().sessions[0].price, 999);
    assert.equal(reloaded.snapshot().sessions[0].locked, true);
    assert(reloaded.element('task2-table-body').children[0].innerHTML.includes('readonly'));
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

  test(`${filename}: edits still update statistics and chart after identical refreshes`, async () => {
    const { history, feed } = scenario();
    const page = await createPage(filename, history, feed);
    await page.init();
    const refresh = filename.startsWith('Nav_') ? 'loadStaticJsonHistory()' : 'refreshAdminMarketPrices()';
    await page.run(refresh);
    await page.run(refresh);
    page.element('input-price-0').handlers.input({ target: { value: '200' } });
    assert.equal(page.snapshot().sessions[0].price, 200);
    assert.equal(page.element('statAvgPrice').textContent, '$155.00');
    assert(page.element('badge-change-1').innerHTML.includes('-45.00%'));
    assert(page.element('sparkline-chart-container').innerHTML.includes('200.00'));
    page.element('input-price-0').handlers.input({ target: { value: '' } });
    assert.equal(page.element('statAvgPrice').textContent, '$110.00');
  });

  test(`${filename}: future estimates contribute immediately and survive reload without API data`, async () => {
    const { history, feed } = scenario();
    // Put the last slot beyond the real current date, retaining a matching feed schedule.
    history.activeCycle.sessions[19].dateIso = '2099-12-31';
    history.activeCycle.endDate = '2099-12-31';
    feed.scheduleKey = history.activeCycle.sessions.map(s => `${s.sessionNumber}:${s.dateIso}`).join('|');
    const page = await createPage(filename, history, feed);
    await page.init();
    page.element('input-price-19').handlers.input({ target: { value: '150' } });
    assert.equal(page.snapshot().sessions[19].price, 150);
    assert.equal(page.element('statAvgPrice').textContent, '$120.00');
    assert.equal(page.run('calculateTask2Stats().activeCount'), 3);
    assert(page.element('badge-change-19').innerHTML.includes('+36.36%'));
    const reloaded = await createPage(filename, history, feed, Object.fromEntries(page.storage));
    await reloaded.init();
    assert.equal(reloaded.snapshot().sessions[19].price, 150);
    assert.equal(reloaded.element('statAvgPrice').textContent, '$120.00');
  });

  test(`${filename}: locking after an identical refresh survives a changed API feed on reload`, async () => {
    const { history, feed } = scenario();
    const page = await createPage(filename, history, feed);
    await page.init();
    await page.run(filename.startsWith('Nav_') ? 'loadStaticJsonHistory()' : 'refreshAdminMarketPrices()');
    await page.run(filename.startsWith('Nav_') ? 'loadStaticJsonHistory()' : 'refreshAdminMarketPrices()');
    page.element('input-price-0').handlers.input({ target: { value: '175' } });
    page.element('btn-lock-row-0').handlers.click();
    feed.sessions[0].price = 500;
    const reloaded = await createPage(filename, history, feed, Object.fromEntries(page.storage));
    await reloaded.init();
    assert.equal(reloaded.snapshot().sessions[0].price, 175);
    assert.equal(reloaded.snapshot().sessions[0].locked, true);
  });

  test(`${filename}: changing tabs does not refresh or overwrite a manual estimate`, async () => {
    const { history, feed } = scenario();
    const page = await createPage(filename, history, feed);
    await page.init();
    const requestsBefore = page.data.requests.length;
    page.element('input-price-0').handlers.input({ target: { value: '180' } });
    await page.callbacks['document:visibilitychange']?.();
    assert.equal(page.snapshot().sessions[0].price, 180);
    assert.equal(page.data.requests.length, requestsBefore);
  });

  test(`${filename}: API failure on reload keeps manual values and locks`, async () => {
    for (const feedOnly of [false, true]) {
      const { history, feed } = scenario();
      const page = await createPage(filename, history, feed);
      await page.init();
      page.element('input-price-0').handlers.input({ target: { value: '180' } });
      page.element('input-price-1').handlers.input({ target: { value: '190' } });
      page.element('btn-lock-row-1').handlers.click();
      const reloaded = await createPage(filename, history, feed, Object.fromEntries(page.storage));
      reloaded.data[feedOnly ? 'feedOffline' : 'offline'] = true;
      await reloaded.init();
      assert.deepEqual(reloaded.snapshot().sessions.slice(0, 2).map(s => s.price), [180, 190]);
      assert.equal(reloaded.snapshot().sessions[1].locked, true);
    }
  });

  test(`${filename}: an estimate entered during a pending update is preserved until the next update`, async () => {
    const { history, feed } = scenario();
    const page = await createPage(filename, history, feed);
    await page.init();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    page.data.beforeResponse = url => url.startsWith('./market_prices.json') ? gate : undefined;
    const refresh = filename.startsWith('Nav_') ? 'loadStaticJsonHistory()' : 'refreshAdminMarketPrices()';
    const pending = page.run(refresh);
    page.element('input-price-0').handlers.input({ target: { value: '180' } });
    release();
    await pending;
    assert.equal(page.snapshot().sessions[0].price, 180);
    assert.equal(page.element('statAvgPrice').textContent, '$145.00');
    await page.run(refresh);
    assert.equal(page.snapshot().sessions[0].price, 100);
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

test('Admin page: finalize and archive preserve the displayed estimates without refreshing API prices', async () => {
  const { history, feed } = scenario();
  const page = await createPage('admin_cycle_manager.html', history, feed);
  await page.init();
  page.element('input-price-0').handlers.input({ target: { value: '160' } });
  page.data.feed = makeFeed(history.activeCycle, feed, new Map([[history.activeCycle.sessions[0].dateIso, 120]]), now);
  const requestsBefore = page.data.requests.length;
  await page.element('btn-finalize-cycle').handlers.click();
  assert.equal(page.snapshot().finalized, true);
  let result = JSON.parse(page.run('JSON.stringify(buildFullJsonPackage())'));
  assert.equal(result.activeCycle.sessions[0].price, 160);
  assert.equal(result.activeCycle.avgPrice, 135);
  assert.equal(page.data.requests.length, requestsBefore);
  page.data.feed.sessions[0].price = 500;
  await page.run('refreshAdminMarketPrices()');
  assert.equal(page.snapshot().sessions[0].price, 160);
  await page.element('btn-save-history').handlers.click();
  result = JSON.parse(page.run('JSON.stringify(buildFullJsonPackage())'));
  assert.equal(result.history[0].avgPrice, 135);
  assert.equal(result.history[0].sessions[0].price, 160);
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

test('Admin page: exporting JSON preserves displayed estimates without an API update', async () => {
  const { history, feed } = scenario();
  const page = await createPage('admin_cycle_manager.html', history, feed);
  await page.init();
  page.element('input-price-0').handlers.input({ target: { value: '180' } });
  page.run('downloadFile = (name, text) => { globalThis.exportedJson = text; };');
  const requestsBefore = page.data.requests.length;
  await page.element('btn-export-json').handlers.click();
  const result = JSON.parse(page.run('exportedJson'));
  assert.equal(result.activeCycle.sessions[0].price, 180);
  assert.equal(result.activeCycle.avgPrice, 145);
  assert.equal(page.data.requests.length, requestsBefore);
});

test('Admin page: a newly published revision replaces an older local draft', async () => {
  const { history, feed } = scenario();
  const page = await createPage('admin_cycle_manager.html', history, feed);
  await page.init();
  page.element('input-price-0').handlers.input({ target: { value: '180' } });
  page.element('btn-lock-row-0').handlers.click();
  history.activeCycle.updatedAt = '2026-11-16T01:00:00Z';
  history.activeCycle.sessions[0] = { ...history.activeCycle.sessions[0], price: 210, locked: true };
  const reloaded = await createPage('admin_cycle_manager.html', history, feed, Object.fromEntries(page.storage));
  await reloaded.init();
  assert.equal(reloaded.snapshot().sessions[0].price, 210);
  assert.equal(reloaded.snapshot().sessions[0].locked, true);
});

test('Admin page: a draft cannot resurrect an archived published cycle', async () => {
  const { history, feed } = scenario();
  const page = await createPage('admin_cycle_manager.html', history, feed);
  await page.init();
  page.element('btn-lock-row-0').handlers.click();
  history.history = [history.activeCycle];
  history.activeCycle = null;
  const reloaded = await createPage('admin_cycle_manager.html', history, feed, Object.fromEntries(page.storage));
  await reloaded.init();
  assert.equal(reloaded.snapshot().sessions.length, 0);
});
