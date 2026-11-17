import assert from 'node:assert/strict';
import test from 'node:test';
import { createPage } from './browser-test-support.mjs';
import { makeCycle } from './stock-test-support.mjs';

const filename = 'admin_cycle_manager.html';
const feed = { schemaVersion: 1, sessions: [] };
const anchor = '2027-02-15';

function packageData(finalized = false) {
  const cycle = makeCycle();
  cycle.isFinalized = finalized;
  cycle.sessions[0] = { ...cycle.sessions[0], locked: true, price: 100 };
  return { activeCycle: cycle, history: [{ ...structuredClone(cycle), id: 'archived', avgPrice: 100 }] };
}

function selectNextCycle(page) {
  page.element('target-date-input').value = anchor;
  page.element('target-date-input').handlers.change({ target: { value: anchor } });
}

for (const finalized of [false, true]) {
  for (const options of [{}, { legacyHelper: true }, { missingIcons: true }]) {
    test(`Admin Apply Cycle: creates a new cycle with finalized=${finalized}, dependencies=${JSON.stringify(options)}`, async () => {
      const history = packageData(finalized);
      const page = await createPage(filename, history, feed, {}, options);
      await page.init();
      selectNextCycle(page);
      page.element('btn-apply-cycle').handlers.click();
      const state = page.snapshot();
      assert.equal(state.meta.year, 2027);
      assert.equal(state.meta.quarter, 1);
      assert.equal(state.sessions.length, 20);
      assert(state.sessions.every(s => s.price === null && !s.locked));
      assert.equal(state.finalized, false);
      assert.equal(page.element('task2-panel').classList.contains('hidden'), false);
      assert(page.element('toast-message').textContent.includes('2027'));
      const output = JSON.parse(page.run('JSON.stringify(buildFullJsonPackage())'));
      assert.equal(output.activeCycle.id, state.meta.id);
      assert.equal(output.activeCycle.startDate, state.sessions[0].dateIso || state.sessions[0].date.slice(0, 10));
      assert.equal(output.history[0].id, history.history[0].id);
      assert.equal(output.history[0].avgPrice, 100);
    });
  }
}

test('Admin Apply Cycle: delayed startup data cannot replace the newly applied cycle', async () => {
  const history = packageData();
  const page = await createPage(filename, history, feed);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  page.data.beforeResponse = url => url.startsWith('./history_data.json') ? gate : undefined;
  const initializing = page.init();
  selectNextCycle(page);
  page.element('btn-apply-cycle').handlers.click();
  const newId = page.snapshot().meta.id;
  page.element('input-price-0').handlers.input({ target: { value: '150' } });
  page.element('btn-lock-row-0').handlers.click();
  release();
  await initializing;
  assert.equal(page.snapshot().meta.id, newId);
  assert.equal(page.snapshot().sessions[0].price, 150);
  assert.equal(page.snapshot().sessions[0].locked, true);
  assert.equal(page.element('target-date-input').value, anchor);
  assert.equal(page.run('adminHistory.length'), history.history.length);
  const reloaded = await createPage(filename, history, feed, Object.fromEntries(page.storage));
  await reloaded.init();
  assert.equal(reloaded.snapshot().meta.id, history.activeCycle.id);
  assert.equal(reloaded.snapshot().sessions[0].price, 100);
  assert.equal(reloaded.snapshot().sessions[0].locked, true);
});

test('Admin Apply Cycle: selecting a date during startup keeps the selected preview until Apply', async () => {
  const page = await createPage(filename, packageData(), feed);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  page.data.beforeResponse = url => url.startsWith('./history_data.json') ? gate : undefined;
  const initializing = page.init();
  selectNextCycle(page);
  release();
  await initializing;
  assert.equal(page.element('target-date-input').value, anchor);
  assert.equal(page.run('task1Result.year'), 2027);
  page.element('btn-apply-cycle').handlers.click();
  assert.equal(page.snapshot().meta.year, 2027);
});

test('Admin Apply Cycle: an offline startup fallback does not undo a new date selection', async () => {
  const history = packageData();
  const original = await createPage(filename, history, feed);
  await original.init();
  const page = await createPage(filename, history, feed, Object.fromEntries(original.storage));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  page.data.beforeResponse = url => url.startsWith('./history_data.json') ? gate : undefined;
  page.data.offline = true;
  const initializing = page.init();
  selectNextCycle(page);
  release();
  await initializing;
  assert.equal(page.element('target-date-input').value, anchor);
  page.element('btn-apply-cycle').handlers.click();
  assert.equal(page.snapshot().meta.year, 2027);
});
