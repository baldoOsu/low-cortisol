// Read-only live check on X: loads the extension into a COPY of a logged-in Chrome profile, scrolls x.com/home and
// reports what the extension decided. It never clicks, types or navigates anywhere but x.com/home.
// Usage:
//   node scripts/live-x-check.mjs --chrome <chrome.exe> --user-data-dir <COPY dir> --extension <dist/dev|dist/prod>
//     [--hide on|off] [--scrolls 25] [--pause-ms 1500] [--out <dir, default %TEMP%\lc-live>] [--snapshot] [--headless]
// Exit: 0 posts seen and some have a verdict; 1 otherwise (or aborted); 2 not logged in or DOM changed.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { launchChromePipe } from './lib/cdp-pipe.mjs';
import { describeUrl, findSessionRestoreData, isDefaultUserDataDir, isHomeUrl, onlyOnHome } from './lib/live-guards.mjs';
import { sampleFromCell, summarize } from './lib/live-report.mjs';

const HOME_URL = 'https://x.com/home';
const ARTICLE_SELECTOR = '[data-testid="primaryColumn"] article';
const TIMELINE_TIMEOUT_MS = 30_000;
const SW_TIMEOUT_MS = 10_000;
const FINAL_WAIT_MS = 15_000;
const POLL_MS = 500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseCli() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        chrome: { type: 'string' },
        'user-data-dir': { type: 'string' },
        extension: { type: 'string' },
        hide: { type: 'string' },
        scrolls: { type: 'string', default: '25' },
        'pause-ms': { type: 'string', default: '1500' },
        out: { type: 'string', default: join(tmpdir(), 'lc-live') },
        snapshot: { type: 'boolean', default: false },
        headless: { type: 'boolean', default: false },
      },
    }));
  } catch (err) {
    fail(err.message);
  }
  for (const name of ['chrome', 'user-data-dir', 'extension']) if (!values[name]) fail(`missing --${name}`);
  if (isDefaultUserDataDir(values['user-data-dir'])) {
    fail(`refusing --user-data-dir ${resolve(values['user-data-dir'])}: that is Chrome's default profile directory; pass a COPY instead`);
  }
  // Restored tabs would load before the tool can close them (and could be /messages), so refuse; never delete.
  const restore = findSessionRestoreData(resolve(values['user-data-dir']));
  if (restore.length > 0) {
    fail(
      `refusing --user-data-dir ${resolve(values['user-data-dir'])}: the profile copy would restore previous tabs at launch:\n` +
        restore.map((r) => `  - ${r}`).join('\n') +
        '\nIn the COPY only: delete those session files and set "On startup" to "Open the New Tab page", then retry.',
    );
  }
  if (values.hide !== undefined && values.hide !== 'on' && values.hide !== 'off') fail('--hide must be on or off');
  const scrolls = Number(values.scrolls);
  const pauseMs = Number(values['pause-ms']);
  if (!Number.isInteger(scrolls) || scrolls < 0) fail('--scrolls must be a non-negative integer');
  if (!Number.isInteger(pauseMs) || pauseMs < 0) fail('--pause-ms must be a non-negative integer');
  const extension = resolve(values.extension);
  if (!existsSync(join(extension, 'manifest.json'))) fail(`no manifest.json in ${extension}`);
  return {
    chrome: values.chrome,
    userDataDir: resolve(values['user-data-dir']),
    extension,
    hide: values.hide,
    scrolls,
    pauseMs,
    out: resolve(values.out),
    snapshot: values.snapshot,
    headless: values.headless,
  };
}

// ---- Page-side collection (runs in x.com via Runtime.evaluate; returns ids and panel text only, never post text) ----

// Re-checks the location in the page: a navigation racing the collect yields [] instead of another page's posts.
const COLLECT_EXPRESSION = onlyOnHome(`(() => {
  const panelText = (host) => {
    const root = host.shadowRoot || host;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let text = '';
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.parentElement && n.parentElement.closest('style')) continue;
      text += n.data;
    }
    return text;
  };
  const out = [];
  for (const article of document.querySelectorAll(${JSON.stringify(ARTICLE_SELECTOR)})) {
    const link = [...article.querySelectorAll('a[href*="/status/"]')].find((a) => a.querySelector('time'));
    const m = link && (link.getAttribute('href') || '').match(/\\/status\\/(\\d+)/);
    if (!m) continue;
    const cell = article.closest('div[data-testid="cellInnerDiv"]');
    const hidden = (!!cell && cell.hasAttribute('data-lc-hidden')) || article.hasAttribute('data-lc-hidden');
    const host = article.querySelector('[data-lc-panel]');
    out.push({ postId: m[1], hidden, panelText: host ? panelText(host) : null });
  }
  return out;
})()`, '[]');

async function evaluate(cdp, sessionId, expression) {
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
  if (exceptionDetails) throw new Error(`evaluate failed: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
  return result.value;
}

// ---- Steps ----

async function findServiceWorker(cdp, extensionId) {
  const prefix = `chrome-extension://${extensionId}/`;
  const deadline = Date.now() + SW_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const sw = targetInfos.find((t) => t.type === 'service_worker' && t.url.startsWith(prefix));
    if (sw) return sw.targetId;
    await sleep(POLL_MS);
  }
  return null;
}

async function setHide(cdp, extensionId, hideEnabled) {
  const targetId = await findServiceWorker(cdp, extensionId);
  if (!targetId) throw new Error('extension service worker not found; cannot set --hide');
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  // Merge into the stored settings so the profile's other choices (threshold, vision…) survive.
  await evaluate(
    cdp,
    sessionId,
    `chrome.storage.local.get('settings').then((r) => chrome.storage.local.set({ settings: { ...(r.settings || {}), hideEnabled: ${hideEnabled}, showResults: true } })).then(() => true)`,
  );
  await cdp.send('Target.detachFromTarget', { sessionId });
}

async function run(opts) {
  const cdp = await launchChromePipe({
    chrome: opts.chrome,
    userDataDir: opts.userDataDir,
    extraArgs: opts.headless ? ['--headless', '--window-size=1280,1600'] : [],
  });
  try {
    return await check(cdp, opts);
  } finally {
    await cdp.close();
  }
}

async function check(cdp, opts) {
  // 1. The extension.
  const { id: extensionId } = await cdp.send('Extensions.loadUnpacked', { path: opts.extension });
  console.log(`extension loaded: ${extensionId}`);

  // 2. Settings.
  if (opts.hide) {
    await setHide(cdp, extensionId, opts.hide === 'on');
    console.log(`settings: hideEnabled=${opts.hide === 'on'}, showResults=true`);
  }

  // 3. Our page. Any other page (restored session, popups) is closed unread.
  const { targetId: pageTargetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  cdp.on('Target.targetCreated', ({ targetInfo }) => {
    if (targetInfo.type !== 'page' || targetInfo.targetId === pageTargetId) return;
    if (targetInfo.url !== 'about:blank') console.warn('closing a page the tool did not open');
    cdp.send('Target.closeTarget', { targetId: targetInfo.targetId }).catch(() => {});
  });
  // Also reports every existing target through Target.targetCreated.
  await cdp.send('Target.setDiscoverTargets', { discover: true });

  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: pageTargetId, flatten: true });

  // 4. Navigation guard: the main frame may only ever show x.com/home.
  let mainFrameId = null;
  let leftHome = null;
  let reachedX = false;
  const checkUrl = (url) => {
    if (isHomeUrl(url)) {
      reachedX = true;
      return;
    }
    if (!reachedX && url === 'about:blank') return;
    leftHome ??= describeUrl(url);
  };
  cdp.on('Page.frameNavigated', ({ frame }, sid) => {
    if (sid !== sessionId || frame.parentId) return;
    mainFrameId = frame.id;
    checkUrl(frame.url);
  });
  cdp.on('Page.navigatedWithinDocument', ({ frameId, url }, sid) => {
    if (sid === sessionId && frameId === mainFrameId) checkUrl(url);
  });
  await cdp.send('Page.enable', {}, sessionId);
  mainFrameId = (await cdp.send('Page.getFrameTree', {}, sessionId)).frameTree.frame.id;

  const { errorText } = await cdp.send('Page.navigate', { url: HOME_URL }, sessionId);

  // 5. Wait for the timeline.
  const deadline = Date.now() + TIMELINE_TIMEOUT_MS;
  let found = false;
  while (!leftHome && Date.now() < deadline) {
    found = await evaluate(cdp, sessionId, `!!document.querySelector(${JSON.stringify(ARTICLE_SELECTOR)})`).catch(() => false);
    if (found) break;
    await sleep(POLL_MS);
  }
  if (!found || leftHome) {
    const why = [leftHome && `page went to ${leftHome}`, errorText && `navigation error ${errorText}`].filter(Boolean).join('; ');
    console.error(`not logged in or DOM changed${why ? ` (${why})` : ''}`);
    return 2;
  }

  // 6. Scroll and collect. A failed collect is logged and skipped; any other failure still writes the report.
  const samples = new Map();
  const collect = async () => {
    try {
      const cells = await evaluate(cdp, sessionId, COLLECT_EXPRESSION);
      for (const cell of cells) samples.set(cell.postId, sampleFromCell(cell));
    } catch (err) {
      console.error(`\ncollect failed, continuing: ${err.message}`);
    }
  };
  const waitGuarded = async (ms) => {
    const end = Date.now() + ms;
    while (!leftHome && Date.now() < end) await sleep(Math.min(POLL_MS, end - Date.now()));
  };
  const aborted = () => {
    if (!leftHome) return false;
    console.error(`aborted: page navigated away from x.com/home (to ${leftHome})`);
    return true;
  };

  let failed = false;
  try {
    for (let i = 0; i < opts.scrolls && !failed; i++) {
      await evaluate(cdp, sessionId, 'window.scrollBy(0, Math.round(innerHeight * 0.8)), true');
      await waitGuarded(opts.pauseMs);
      if (aborted()) failed = true;
      else {
        await collect();
        process.stdout.write(`\rscroll ${i + 1}/${opts.scrolls}: ${samples.size} posts`);
      }
    }
    if (opts.scrolls > 0) process.stdout.write('\n');
    if (!failed) {
      console.log(`waiting ${FINAL_WAIT_MS / 1000} s for vision passes…`);
      await waitGuarded(FINAL_WAIT_MS);
      if (aborted()) failed = true;
      else await collect();
    }
  } catch (err) {
    console.error(`\nlive check failed: ${err.message}`);
    failed = true;
  }

  // 7. Report (ids and verdicts only, never post text), written with whatever was collected.
  const list = [...samples.values()];
  const summary = summarize(list);
  mkdirSync(opts.out, { recursive: true });
  const reportPath = join(opts.out, 'live-report.json');
  const report = {
    generatedAt: new Date().toISOString(),
    extensionId,
    hide: opts.hide ?? null,
    scrolls: opts.scrolls,
    complete: !failed,
    summary,
    samples: list.map(({ postId, verdict, hidden, vision, errorCode }) => ({ postId, verdict, hidden, vision, errorCode: errorCode ?? null })),
  };
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(`report: ${reportPath}`);
  if (opts.snapshot) await writeSnapshot();

  // 8. Summary.
  console.log(JSON.stringify(summary, null, 2));
  return !failed && summary.posts > 0 && summary.withVerdict > 0 ? 0 : 1;

  async function writeSnapshot() {
    // Re-check the guard right before reading, and again inside the page, so the snapshot is only ever x.com/home.
    if (aborted()) return console.warn('snapshot skipped: not on x.com/home');
    const html = await evaluate(
      cdp,
      sessionId,
      onlyOnHome(`document.querySelector('[data-testid="primaryColumn"]')?.outerHTML ?? ''`, 'null'),
    ).catch((err) => {
      console.error(`snapshot failed: ${err.message}`);
      return undefined;
    });
    if (html === undefined) return;
    if (html === null) return console.warn('snapshot skipped: not on x.com/home');
    const snapPath = join(opts.out, 'primaryColumn.html');
    writeFileSync(snapPath, html);
    console.log(`snapshot (local only, contains timeline content): ${snapPath}`);
  }
}

const opts = parseCli();
try {
  process.exitCode = await run(opts);
} catch (err) {
  console.error(`live check failed: ${err.message}`);
  process.exitCode = 1;
}
