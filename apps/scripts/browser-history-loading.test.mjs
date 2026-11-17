import assert from 'node:assert/strict';
import test from 'node:test';
import { createPage } from './browser-test-support.mjs';
import { makeCycle } from './stock-test-support.mjs';

function historyPackage() {
  const cycle = makeCycle();
  const record = {
    ...structuredClone(cycle), id: 'archived-cycle', avgPrice: 105,
    firstPrice: 100, latestPrice: 110, totalChangePct: 10, activeCount: 2,
    savedAt: '2026-11-16T00:00:00Z'
  };
  record.sessions[0].price = 100;
  record.sessions[1].price = 110;
  return { activeCycle: cycle, history: [record] };
}

const emptyFeed = { schemaVersion: 1, sessions: [] };

for (const filename of ['Nav_record_stock.html', 'admin_cycle_manager.html']) {
  for (const [caseName, options] of [
    ['current scripts', {}],
    ['a cached helper without the new badge method', { legacyHelper: true }],
    ['an unavailable icon CDN', { missingIcons: true }],
    ['an unavailable price helper', { missingHelper: true }]
  ]) {
    test(`${filename}: history loads with ${caseName}`, async () => {
      const history = historyPackage();
      const page = await createPage(filename, history, emptyFeed, {}, options);
      await page.init();
      assert(page.data.requests.some(url => url.startsWith('./history_data.json')));
      assert(page.element('history-container').innerHTML.includes('$105.00'));
      assert(page.element('history-container').innerHTML.includes('2026/10/19'));
      assert.equal(page.run(filename.startsWith('Nav_') ? 'staticJsonHistory.length' : 'adminHistory.length'), 1);
    });
  }

  test(`${filename}: archived history renders and expands without replacing data`, async () => {
    const history = historyPackage();
    const before = JSON.stringify(history);
    const page = await createPage(filename, history, emptyFeed);
    await page.init();
    assert(page.element('history-count-badge').textContent.startsWith(String(history.history.length)));
    for (const record of history.history) {
      page.run(`openHistoryDetailId = ${JSON.stringify(record.id)}; renderHistoryList();`);
      assert(page.element('history-container').innerHTML.includes(record.startDate.replaceAll('-', '/')));
      assert(page.element('history-container').innerHTML.includes(record.sessions[0].dateIso));
    }
    assert.equal(JSON.stringify(history), before);
  });

  test(`${filename}: the helper script URL includes a version to avoid cached incompatible JavaScript`, async () => {
    const page = await createPage(filename, historyPackage(), emptyFeed);
    assert.match(page.html, /src="\.\/stock-price-sync\.js\?v=[^"]+"/);
  });
}
