// Fake `claude -p` for companion tests. Reads stdin fully, then behaves per FAKE_CLAUDE_MODE:
// success (default) | is_error | exit1 | hang | env.
const mode = process.env.FAKE_CLAUDE_MODE ?? 'success';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = Buffer.concat(chunks).toString('utf8');

const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const result = (items) => out({ type: 'result', subtype: 'success', is_error: false, structured_output: { items } });

switch (mode) {
  case 'success': {
    const msg = JSON.parse(input.split('\n')[0]);
    const images = msg.message.content.filter((c) => c.type === 'image').length;
    out({ type: 'system', subtype: 'init' });
    out({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.02 }, seven_day: { utilization: 0.1 } } },
    });
    result(Array.from({ length: images }, (_, k) => ({ index: k + 1, visible_text: `TEXT ${k + 1}`, description: `desc ${k + 1}`, cues: ['meme'] })));
    process.stderr.write('[claude-code:unrecognized_model] {"model":"claude-sonnet-5-5"}\n');
    process.exitCode = 0;
    break;
  }
  case 'is_error':
    out({ type: 'result', subtype: 'error', is_error: true, result: 'boom' });
    process.exitCode = 0;
    break;
  case 'exit1':
    process.stderr.write('fake claude failure\n');
    process.exitCode = 1;
    break;
  case 'hang':
    setInterval(() => {}, 1000);
    break;
  case 'env':
    result([
      {
        index: 1,
        visible_text: JSON.stringify({ a: process.env.ANTHROPIC_API_KEY ?? null, t: process.env.TYPESAFE_API_KEY ?? null }),
        description: 'env',
        cues: [],
      },
    ]);
    break;
  default:
    process.stderr.write(`unknown FAKE_CLAUDE_MODE ${mode}\n`);
    process.exitCode = 2;
}
