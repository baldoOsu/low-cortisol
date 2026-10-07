// Live smoke test: the built host transcribing test/fixtures/images/probe.png through the real `claude` CLI.
// Needs `npm run build` and a logged-in Claude Code. Usage: node scripts/smoke-vision.mjs [--model claude-sonnet-5-5]
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeError, HOST, startHost } from './lib/host-client.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROBE = join(root, 'test', 'fixtures', 'images', 'probe.png');
const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5'];

function parseModel(argv) {
  const i = argv.indexOf('--model');
  if (i === -1) return MODELS[0];
  const model = argv[i + 1];
  if (!MODELS.includes(model)) throw new Error(`--model must be one of ${MODELS.join(', ')}`);
  return model;
}

async function main() {
  let model;
  try {
    model = parseModel(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    return 1;
  }
  if (!existsSync(HOST)) {
    console.error('dist/companion/host.cjs not found: run npm run build first');
    return 1;
  }
  const item = { key: 'smoke/probe', kind: 'image', inQuote: false, mediaType: 'image/png', dataBase64: readFileSync(PROBE).toString('base64') };
  const request = { type: 'transcribe', model, items: [item] };
  const host = startHost();
  let failed = false;
  try {
    const hello = await host.request({ type: 'hello', flavor: 'dev', extVersion: 'smoke' }, 5000);
    if (!hello.ok) throw new Error(`hello: ${describeError(hello)}`);
    console.log(`hello: jevConfigured=${hello.jevConfigured} claudeFound=${hello.claudeFound}`);

    const r = await host.request(request, 150_000);
    if (!r.ok) throw new Error(`transcribe: ${describeError(r)}`);
    const t = r.transcripts[0];
    if (!t) throw new Error('transcribe: no transcript returned');
    const text = JSON.stringify(t.visibleText.replace(/\s+/g, ' ').slice(0, 60)).slice(1, -1);
    const util = r.rateLimit?.fiveHourUtilization;
    const fiveHour = typeof util === 'number' ? Math.round(util * 100) : '?';
    console.log(`transcribe: ok ${t.model} ${r.latencyMs}ms text="${text}" cues=[${t.cues.join(',')}] 5h=${fiveHour}%`);

    const again = await host.request(request, 150_000);
    if (!again.ok) throw new Error(`transcribe (repeat): ${describeError(again)}`);
    console.log(`cached=[${again.cachedKeys.join(',')}]`);
    if (!again.cachedKeys.includes(item.key)) throw new Error(`expected ${item.key} to be cached on the repeat request`);
  } catch (err) {
    console.log(`smoke-vision: ${err.message}`);
    failed = true;
  }
  const code = await host.stop();
  if (code !== 0) {
    console.log(`host exit: ${code}`);
    failed = true;
  }
  return failed ? 1 : 0;
}

process.exitCode = await main();
