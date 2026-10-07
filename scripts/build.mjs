// Builds dist/dev, dist/prod (unpacked MV3 extensions with pinned IDs) and dist/companion. Usage: node scripts/build.mjs
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { extensionIdFromPublicKey, HOST_NAME, makeManifest } from './lib/manifest.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rel = (...parts) => join(root, ...parts);
const FLAVORS = ['dev', 'prod'];
const ICON_SIZES = [16, 48, 128];

const EXTENSION_ENTRIES = {
  content: 'extension/src/content/main.ts',
  background: 'extension/src/background/main.ts',
  popup: 'extension/src/popup/popup.ts',
};
const COMPANION_ENTRY = 'companion/src/main.ts';

function fail(message) {
  console.error(message);
  process.exit(1);
}

function clean(dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

// 1. Version.
const version = JSON.parse(readFileSync(rel('package.json'), 'utf8')).version;

// 2. Keys (they pin the extension IDs).
const keys = {};
for (const flavor of FLAVORS) {
  const file = rel('extension', 'keys', `${flavor}.pub.b64`);
  if (!existsSync(file)) fail(`missing ${flavor} key (extension/keys/${flavor}.pub.b64): run npm run gen:keys first`);
  keys[flavor] = readFileSync(file, 'utf8').trim();
}

// Check every entry before cleaning anything, so a partial tree never wipes a good dist/.
const missing = [...Object.values(EXTENSION_ENTRIES), COMPANION_ENTRY].filter((p) => !existsSync(rel(p)));
if (missing.length) fail(missing.map((p) => `missing entry: ${p}`).join('\n'));

// 3. Extensions.
const ids = {};
for (const flavor of FLAVORS) {
  const out = rel('dist', flavor);
  clean(out);
  await build({
    entryPoints: Object.fromEntries(Object.entries(EXTENSION_ENTRIES).map(([name, p]) => [name, rel(p)])),
    outdir: out,
    entryNames: '[name]',
    bundle: true,
    format: 'iife',
    target: 'chrome120',
    define: { __FLAVOR__: JSON.stringify(flavor) },
    minify: false,
    legalComments: 'none',
    sourcemap: flavor === 'dev' ? 'inline' : false,
    logLevel: 'warning',
  });
  for (const f of ['popup.html', 'popup.css']) copyFileSync(rel('extension', 'static', f), join(out, f));
  mkdirSync(join(out, 'icons'));
  for (const size of ICON_SIZES) {
    copyFileSync(rel('extension', 'static', 'icons', `${flavor}-${size}.png`), join(out, 'icons', `icon-${size}.png`));
  }
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(makeManifest(flavor, keys[flavor], version), null, 2) + '\n');
  ids[flavor] = extensionIdFromPublicKey(keys[flavor]);
}

// 4. Companion.
const companionOut = rel('dist', 'companion');
clean(companionOut);
await build({
  entryPoints: [rel(COMPANION_ENTRY)],
  outfile: join(companionOut, 'host.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  define: { __COMPANION_VERSION__: JSON.stringify(version) },
  banner: { js: '#!/usr/bin/env node' },
  legalComments: 'none',
  logLevel: 'warning',
});
for (const f of ['install-windows.ps1', 'uninstall-windows.ps1']) {
  const src = rel('companion', 'install', f);
  if (existsSync(src)) copyFileSync(src, join(companionOut, f));
}
writeFileSync(
  join(companionOut, 'README.txt'),
  [
    'Low Cortisol companion (Native Messaging host for the Low Cortisol Chrome extension).',
    'host.cjs is the bundled host; it needs Node 20+ and nothing else.',
    'Install on Windows with install-windows.ps1; remove with uninstall-windows.ps1.',
    'extension-ids.json lists the dev/prod extension IDs the host allows.',
    'Full instructions: docs/INSTALL-WINDOWS.md',
  ].join('\n') + '\n',
);

// 5. Extension IDs.
const idsJson = JSON.stringify({ hostName: HOST_NAME, dev: ids.dev, prod: ids.prod }, null, 2) + '\n';
writeFileSync(rel('dist', 'extension-ids.json'), idsJson);
writeFileSync(join(companionOut, 'extension-ids.json'), idsJson);

// 6. Summary.
console.log(`Low Cortisol ${version} built:`);
for (const flavor of FLAVORS) console.log(`  ${`dist/${flavor}`.padEnd(16)}extension id ${ids[flavor]}`);
console.log(`  ${'dist/companion'.padEnd(16)}host ${HOST_NAME}`);
