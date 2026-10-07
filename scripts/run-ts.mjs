// Usage: node scripts/run-ts.mjs <entry.ts> [...args]
// Bundles a TypeScript entry with esbuild into a temp .mjs and runs it with argv = [node, entry, ...args].

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const [entryArg, ...args] = process.argv.slice(2);
if (!entryArg) {
  console.error('Usage: node scripts/run-ts.mjs <entry.ts> [...args]');
  process.exit(1);
}
const entry = resolve(entryArg);

const result = await build({
  entryPoints: [entry],
  platform: 'node',
  format: 'esm',
  bundle: true,
  write: false,
  logLevel: 'warning',
});
const code = result.outputFiles[0].text;
const hash = createHash('sha256').update(entry).update('\0').update(code).digest('hex').slice(0, 16);
const out = join(tmpdir(), `lc-run-${hash}.mjs`);
writeFileSync(out, code);

process.argv = [process.argv[0], entry, ...args];
await import(pathToFileURL(out).href);
