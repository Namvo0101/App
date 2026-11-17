import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { preparePages } from './prepare-pages.mjs';

test('Pages contains website, original JSON and root pages, excluding deployment sources/secrets', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'app-pages-'));
  try {
    const files = {
      'index.html': 'home', 'Time_transfer.html': 'transfer', 'CNAME': 'example.com',
      'apps/Nav_record_stock.html': 'user', 'apps/admin_cycle_manager.html': 'admin',
      'apps/other-page.html': 'other', 'apps/stock-price-sync.js': 'sync',
      'apps/history_data.json': '{"committed":true}', 'apps/market_prices.json': '{"latest":"2026-11-16"}',
      'assets/logo.svg': '<svg/>', 'apps/.env': 'must-not-publish',
      'apps/scripts/update-stock-prices.mjs': 'backend', 'apps/node_modules/example/index.js': 'dependency',
      'infra/cloudflare-stock-cron/wrangler.json': '{}', 'infra/cloudflare-stock-cron/src/index.js': 'worker',
      '.github/workflows/update-stock-prices.yml': 'workflow',
      'CLOUDFLARE_CRON.md': 'private deployment guide', '.dev.vars': 'secret', 'backup.zip': 'archive'
    };
    for (const [file, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), content);
    }
    // File symlinks are supported on Unix CI; Windows may require extra privileges.
    let linked = false;
    try { await symlink(path.join(root, '.dev.vars'), path.join(root, 'apps/leak.txt')); linked = true; }
    catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) throw error; }
    const out = path.join(root, '_site');
    await preparePages(root, out);
    assert.deepEqual((await readdir(out)).sort(), ['.nojekyll', 'CNAME', 'Time_transfer.html', 'apps', 'assets', 'index.html'].sort());
    assert.deepEqual((await readdir(path.join(out, 'apps'))).sort(), ['Nav_record_stock.html', 'admin_cycle_manager.html', 'history_data.json', 'market_prices.json', 'other-page.html', 'stock-price-sync.js'].sort());
    for (const file of ['apps/history_data.json', 'apps/market_prices.json', 'apps/stock-price-sync.js', 'index.html']) {
      assert.equal(await readFile(path.join(out, file), 'utf8'), files[file]);
    }
    if (linked) assert.ok(!(await readdir(path.join(out, 'apps'))).includes('leak.txt'));
    await assert.rejects(preparePages(root, out), { code: 'EEXIST' });
    await assert.rejects(preparePages(root, root), /new subdirectory/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Missing master JSON prevents publishing an incomplete website', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'app-pages-missing-'));
  try { await assert.rejects(preparePages(root, path.join(root, '_site')), { code: 'ENOENT' }); }
  finally { await rm(root, { recursive: true, force: true }); }
});
