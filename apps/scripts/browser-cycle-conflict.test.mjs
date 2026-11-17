import assert from 'node:assert/strict';
import test from 'node:test';
import { createPage } from './browser-test-support.mjs';
import { makeCycle } from './stock-test-support.mjs';
import { makeFeed } from './update-stock-prices.mjs';

const filename = 'Nav_record_stock.html';
const now = new Date('2027-01-01T00:00:00Z');

async function conflictingPage(userFinalized = false, adminFinalized = false) {
  const oldCycle = makeCycle();
  const newCycle = structuredClone(oldCycle);
  newCycle.sessions = newCycle.sessions.map(session => {
    const date = new Date(`${session.dateIso}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + 28);
    return { ...session, dateIso: date.toISOString().slice(0, 10) };
  });
  newCycle.startDate = newCycle.sessions[0].dateIso;
  newCycle.endDate = newCycle.sessions.at(-1).dateIso;
  newCycle.id = `2026-Q4-${newCycle.startDate}-${newCycle.endDate}`;
  newCycle.updatedAt = '2026-11-15T00:00:00Z';
  newCycle.sessions[1].price = 75;
  newCycle.sessions[1].locked = true;
  newCycle.isFinalized = adminFinalized;
  const record = { ...structuredClone(oldCycle), id: 'previous-record', avgPrice: 90, savedAt: now.toISOString() };
  const oldFeed = makeFeed(oldCycle, null, new Map([[oldCycle.sessions[0].dateIso, 100]]), now);
  const page = await createPage(filename, { activeCycle: oldCycle, history: [] }, oldFeed);
  await page.init();
  page.element('input-price-0').handlers.input({ target: { value: '150' } });
  page.element('btn-lock-row-0').handlers.click();
  page.element('input-price-10').handlers.input({ target: { value: '177' } });
  page.run(`userLocalHistory = ${JSON.stringify([record])}; saveStateToLocalStorage(); renderHistoryList();`);
  if (userFinalized) page.element('btn-finalize-cycle').handlers.click();
  const savedHistory = page.run('JSON.stringify(userLocalHistory)');
  const oldState = page.snapshot();
  const feed = makeFeed(newCycle, null, new Map([[newCycle.sessions[0].dateIso, 200]]), now);
  const history = { activeCycle: newCycle, history: [] };
  page.data.history = structuredClone(history);
  page.data.feed = structuredClone(feed);
  await page.run('loadStaticJsonHistory()');
  assert.equal(page.element('conflict-modal').classList.contains('hidden'), false);
  assert.equal(page.snapshot().meta.id, oldCycle.id);
  return { page, oldCycle, newCycle, history, feed, savedHistory, oldState };
}

for (const finalized of [false, true]) {
  test(`User cycle conflict: switch now discards the active draft without archiving it (userFinalized=${finalized})`, async () => {
    const { page, newCycle, history, feed, savedHistory } = await conflictingPage(finalized);
    assert(page.html.includes('id="btn-conflict-switch-now"'));
    page.element('btn-conflict-switch-now').onclick();
    const state = page.snapshot();
    assert.equal(state.meta.id, newCycle.id);
    assert.equal(state.sessions[0].price, 200);
    assert.equal(state.sessions[0].locked, false);
    assert.equal(state.sessions[1].price, 75);
    assert.equal(state.sessions[1].locked, true);
    assert.equal(state.sessions[10].price, null);
    assert.equal(state.finalized, false);
    assert.equal(page.run('userFinalized'), false);
    assert.equal(page.run('ignoredMasterCycleId'), null);
    assert.equal(page.run('JSON.stringify(userLocalHistory)'), savedHistory);
    assert.equal(page.element('conflict-modal').classList.contains('hidden'), true);
    const saved = JSON.parse(page.storage.get('NAV_RECORD_STOCK_STATE'));
    assert.equal(saved.activeCycleId, newCycle.id);
    assert.equal(JSON.stringify(saved.userHistory), savedHistory);
    const reloaded = await createPage(filename, history, feed, Object.fromEntries(page.storage));
    await reloaded.init();
    assert.equal(reloaded.snapshot().meta.id, newCycle.id);
    assert.equal(reloaded.element('conflict-modal').classList.contains('hidden'), true);
    assert.equal(reloaded.run('JSON.stringify(userLocalHistory)'), savedHistory);
  });
}

test('User cycle conflict: switching now respects the new Admin finalization', async () => {
  const { page, newCycle, savedHistory } = await conflictingPage(false, true);
  page.element('btn-conflict-switch-now').onclick();
  assert.equal(page.snapshot().meta.id, newCycle.id);
  assert.equal(page.snapshot().finalized, true);
  assert.equal(page.snapshot().sessions[0].price, null);
  assert.equal(page.snapshot().sessions[1].price, 75);
  assert.equal(page.run('JSON.stringify(userLocalHistory)'), savedHistory);
});

test('User cycle conflict: keep my data retains the current draft and its history', async () => {
  const { page, oldState, newCycle, savedHistory } = await conflictingPage();
  page.element('btn-conflict-keep-user').onclick();
  assert.deepEqual(page.snapshot(), oldState);
  assert.equal(page.run('JSON.stringify(userLocalHistory)'), savedHistory);
  assert.equal(page.run('ignoredMasterCycleId'), newCycle.id);
  assert.equal(page.element('conflict-modal').classList.contains('hidden'), true);
});

test('User cycle conflict: save and switch still archives the old draft before loading Admin', async () => {
  const { page, oldCycle, newCycle } = await conflictingPage();
  page.element('btn-conflict-accept-master').onclick();
  assert.equal(page.snapshot().meta.id, newCycle.id);
  const saved = JSON.parse(page.run('JSON.stringify(userLocalHistory)'));
  assert.equal(saved.length, 2);
  assert(saved.some(record => record.id === 'previous-record'));
  const archived = saved.find(record => record.id === oldCycle.id);
  assert(archived);
  assert.equal(archived.sessions[0].price, 150);
  assert.equal(archived.sessions[10].price, 177);
  assert.equal(page.element('conflict-modal').classList.contains('hidden'), true);
});
