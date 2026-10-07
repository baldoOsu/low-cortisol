// Live smoke test: the built host against the real TypeSafe Jev API. Needs `npm run build` and TYPESAFE_API_KEY.
// Usage: node scripts/smoke-jev.mjs   Prints only status, model, score and latency; never env values.
import { existsSync } from 'node:fs';
import { describeError, HOST, startHost } from './lib/host-client.mjs';

const PROBES = {
  rage: "Can you BELIEVE these people?! They want to take away everything you've worked for and then laugh in your face about it. Absolutely disgusting. If you're not furious you're not paying attention. RT if you're sick of it!!",
  news: 'The city council approved the 2027 transit budget on Tuesday, adding two bus routes and extending weekend service hours. The changes take effect in March.',
};

async function main() {
  if (!existsSync(HOST)) {
    console.error('dist/companion/host.cjs not found: run npm run build first');
    return 1;
  }
  const host = startHost();
  let failed = false;
  try {
    const hello = await host.request({ type: 'hello', flavor: 'dev', extVersion: 'smoke' }, 5000);
    if (!hello.ok) throw new Error(`hello: ${describeError(hello)}`);
    console.log(`hello: jevConfigured=${hello.jevConfigured} claudeFound=${hello.claudeFound}`);
    for (const [name, text] of Object.entries(PROBES)) {
      const state = { post: { author: `@smoke_${name}`, text }, media_status: 'none' };
      const r = await host.request({ type: 'classify', state }, 30_000);
      if (!r.ok) {
        console.log(`classify[${name}]: ${describeError(r)}`);
        failed = true;
        continue;
      }
      const p = r.result.answers.ragebait.noul;
      console.log(`classify[${name}]: ok ${r.result.model} ragebait=${p.toFixed(2)} ${r.result.latencyMs}ms`);
    }
  } catch (err) {
    console.log(`smoke-jev: ${err.message}`);
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
