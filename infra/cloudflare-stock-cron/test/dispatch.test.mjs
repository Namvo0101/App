import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import worker from '../src/index.js';
import { CRON, dispatchWorkflow } from '../src/dispatch.js';

const token = 'offline-test-placeholder';
const controller = { cron: CRON, scheduledTime: Date.UTC(2026, 10, 17, 0, 13) };
function fixture(fetchImpl) {
  const logs = [];
  return {
    logs,
    options: {
      fetchImpl, now: () => new Date('2026-11-17T00:13:01Z'),
      logger: { log: value => logs.push(JSON.parse(value)), error: value => logs.push(JSON.parse(value)) }
    }
  };
}

test('Dispatches only the fixed workflow/main and logs returned run details', async () => {
  let calls = 0;
  const f = fixture(async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.github.com/repos/Namvo0101/App/actions/workflows/update-stock-prices.yml/dispatches');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.Authorization, `Bearer ${token}`);
    assert.equal(init.headers['X-GitHub-Api-Version'], '2026-03-10');
    assert.equal(init.headers.Accept, 'application/vnd.github+json');
    assert.equal(init.headers['Content-Type'], 'application/json');
    assert.ok(init.headers['User-Agent']);
    assert.equal(init.redirect, 'manual');
    assert.ok(init.signal instanceof AbortSignal);
    assert.deepEqual(JSON.parse(init.body), { ref: 'main' });
    return Response.json({ workflow_run_id: 123, html_url: 'https://github.com/Namvo0101/App/actions/runs/123' });
  });
  const result = await dispatchWorkflow(controller, { GITHUB_TOKEN: token }, f.options);
  assert.equal(calls, 1);
  assert.equal(result.http_status, 200);
  assert.equal(result.run_id, '123');
  assert.equal(result.run_url, 'https://github.com/Namvo0101/App/actions/runs/123');
  assert.equal(result.triggered_at, '2026-11-17T00:13:01.000Z');
  assert.equal(result.scheduled_at, '2026-11-17T00:13:00.000Z');
  assert.equal(f.logs[0].event, 'cron_triggered');
  assert.ok(!JSON.stringify(f.logs).includes(token));
});

test('Accepts legacy HTTP 204 without inventing a workflow run ID', async () => {
  const f = fixture(async () => new Response(null, { status: 204 }));
  const result = await dispatchWorkflow(controller, { GITHUB_TOKEN: token }, f.options);
  assert.equal(result.http_status, 204);
  assert.equal(result.run_id, null);
  assert.equal(result.run_url, null);
  assert.match(result.workflow_url, /actions\/workflows\/update-stock-prices.yml$/);
});

test('Logs API run URL when GitHub returns it without an HTML URL', async () => {
  const f = fixture(async () => Response.json({ workflow_run_id: '345', run_url: 'https://api.github.com/repos/Namvo0101/App/actions/runs/345' }));
  const result = await dispatchWorkflow(controller, { GITHUB_TOKEN: token }, f.options);
  assert.equal(result.run_id, '345');
  assert.match(result.run_url, /\/runs\/345$/);
});

for (const status of [302, 401, 403, 404, 422, 429, 500]) {
  test(`HTTP ${status} marks invocation as failed without logging response body or token`, async () => {
    let calls = 0;
    const f = fixture(async () => { calls++; return new Response(`sensitive ${token}`, { status }); });
    await assert.rejects(dispatchWorkflow(controller, { GITHUB_TOKEN: token }, f.options), /GITHUB_REJECTED/);
    assert.equal(calls, 1, 'Do not automatically retry a possibly accepted dispatch');
    assert.equal(f.logs.at(-1).http_status, status);
    assert.ok(!JSON.stringify(f.logs).includes(token));
  });
}

test('Missing/empty secrets fail before any network call', async () => {
  for (const secret of [undefined, '', '   ']) {
    const f = fixture(() => assert.fail('Must not fetch without a secret'));
    await assert.rejects(dispatchWorkflow(controller, { GITHUB_TOKEN: secret }, f.options), /MISSING_SECRET/);
  }
});

test('Unexpected cron fails before dispatch', async () => {
  const f = fixture(() => assert.fail('Must not dispatch an unexpected schedule'));
  await assert.rejects(dispatchWorkflow({ ...controller, cron: '0 * * * *' }, { GITHUB_TOKEN: token }, f.options), /UNEXPECTED_CRON/);
});

test('Network exceptions cannot echo credentials into logs or thrown error', async () => {
  const f = fixture(async () => { throw new Error(`Authorization: Bearer ${token}`); });
  const error = await dispatchWorkflow(controller, { GITHUB_TOKEN: token }, f.options).catch(error => error);
  assert.match(error.message, /GITHUB_NETWORK_ERROR/);
  assert.ok(!error.message.includes(token));
  assert.ok(!JSON.stringify(f.logs).includes(token));
});

test('Untrusted fields in successful responses cannot appear in logs', async () => {
  const f = fixture(async () => Response.json({
    workflow_run_id: token,
    html_url: `https://github.com/Namvo0101/App/actions/runs/123?token=${token}`,
    run_url: `https://example.com/${token}`, message: token
  }));
  const result = await dispatchWorkflow(controller, { GITHUB_TOKEN: token }, f.options);
  assert.equal(result.run_id, null);
  assert.equal(result.run_url, null);
  assert.ok(!JSON.stringify(f.logs).includes(token));
});

test('Accepted response with invalid JSON remains accepted, with no fabricated run details', async () => {
  const f = fixture(async () => new Response('not-json'));
  assert.equal((await dispatchWorkflow(controller, { GITHUB_TOKEN: token }, f.options)).run_id, null);
});

test('Deployed entry point propagates failure and has no HTTP handler', async () => {
  assert.deepEqual(Object.keys(await import('../src/index.js')), ['default']);
  assert.deepEqual(Object.keys(worker), ['scheduled']);
  const originalError = console.error;
  const originalLog = console.log;
  console.error = console.log = () => {};
  try { await assert.rejects(worker.scheduled(controller, {}), /MISSING_SECRET/); }
  finally { console.error = originalError; console.log = originalLog; }
});

test('Wrangler config has exact UTC cron, required secret and no public URLs', async () => {
  const config = JSON.parse(await readFile(new URL('../wrangler.json', import.meta.url), 'utf8'));
  assert.deepEqual(config.triggers.crons, [CRON]);
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  assert.ok(!config.routes && !config.route && !config.assets);
  assert.deepEqual(config.secrets.required, ['GITHUB_TOKEN']);
  assert.equal(config.observability.enabled, true);
  assert.equal(config.observability.head_sampling_rate, 1);
  assert.ok(!config.vars);
});
