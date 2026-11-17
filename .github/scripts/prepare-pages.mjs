import { cp, lstat, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC_DIRS = new Set(['apps', 'assets', 'css', 'js', 'images', 'fonts']);
const PUBLIC_ROOT_FILE = /\.(?:html?|css|js|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|webmanifest|xml|txt)$/i;
const PRIVATE_NAMES = new Set(['scripts', 'node_modules', 'infra', 'test', 'tests']);

// Use a fresh staging directory and an allowlist; never upload the repository root.
export async function preparePages(source, destination) {
  const root = path.resolve(source);
  const out = path.resolve(destination);
  if (root === out || !out.startsWith(`${root}${path.sep}`)) {
    throw new Error('Pages staging directory must be a new subdirectory of the repository.');
  }
  for (const required of ['apps/history_data.json', 'apps/market_prices.json']) {
    if (!(await stat(path.join(root, required))).isFile()) throw new Error(`Missing website data: ${required}`);
  }
  await mkdir(out); // Fail rather than delete/overwrite an existing directory.
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const publicFile = entry.isFile() &&
      (PUBLIC_ROOT_FILE.test(entry.name) || ['CNAME', '.nojekyll'].includes(entry.name));
    if (!publicFile && !(entry.isDirectory() && PUBLIC_DIRS.has(entry.name))) continue;
    await cp(path.join(root, entry.name), path.join(out, entry.name), {
      recursive: true,
      dereference: false,
      filter: async name => {
        const base = path.basename(name);
        return !(await lstat(name)).isSymbolicLink() &&
          (base === '.nojekyll' || (!base.startsWith('.') && !PRIVATE_NAMES.has(base)));
      }
    });
  }
  await writeFile(path.join(out, '.nojekyll'), '');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await preparePages(process.cwd(), path.resolve('_site'));
  console.log('Pages staged in _site: public website files only; infra and .github excluded.');
}
