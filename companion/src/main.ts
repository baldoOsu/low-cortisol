// CLI entry, bundled to dist/companion/host.cjs. Default: Native Messaging host (Chrome passes the
// origin and, on Windows, --parent-window=…). Also: --version, --self-test [--vision]. Spec §5

import { spawn } from 'node:child_process';
import path from 'node:path';
import { format } from 'node:util';
import { FileCache } from './cache';
import { childEnv, transcribe } from './claude';
import { loadConfig, secretsOf } from './config';
import { runHost, type HostDeps } from './host';
import { classifyState } from './jev';
import { createLogger } from './log';
import { runSelfTest } from './selftest';
import { MemoryCache, NULL_LOGGER, type CompanionConfig, type KVCache, type Logger } from './types';

/** 8×8 checkerboard PNG for the self-test vision probe. */
const PROBE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAG0lEQVR4nGOQqzjx4YQNJsmAVVSu4gTDoNQBAIVvakEElprnAAAAAElFTkSuQmCC';
const CLAUDE_VERSION_TIMEOUT_MS = 15_000;

function errorText(err: unknown): string {
  return String((err as Error)?.stack ?? err);
}

function openLog(cfg: CompanionConfig): Logger {
  return createLogger({ file: path.join(cfg.home, 'logs', 'companion.log'), secrets: secretsOf(cfg) });
}

function makeDeps(cfg: CompanionConfig, cache: KVCache, log: Logger): HostDeps {
  return {
    version: __COMPANION_VERSION__,
    cfg,
    log,
    classify: (state) => classifyState(state, { cfg, cache, log }),
    transcribe: (items, model) => transcribe(items, model, { cfg, cache, log }),
  };
}

/** stdout carries frames only: every console method goes to the log instead. */
function redirectConsole(log: () => Logger): void {
  const to = (level: keyof Logger) => (...args: unknown[]) => log()[level]('console', { message: format(...args) });
  const c = console as unknown as Record<string, unknown>;
  for (const m of ['log', 'info', 'debug', 'dir', 'dirxml', 'table']) c[m] = to('info');
  for (const m of ['warn', 'trace']) c[m] = to('warn');
  c.error = to('error');
}

/** First line of `claude --version`, or undefined on any failure. The child never sees the API keys. */
function claudeVersion(claudePath: string | undefined): Promise<string | undefined> {
  if (!claudePath) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    let stdout = '';
    const child = spawn(claudePath, ['--version'], {
      env: childEnv(process.env),
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: CLAUDE_VERSION_TIMEOUT_MS,
    });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (s: string) => (stdout += s));
    child.on('error', () => resolve(undefined));
    child.on('close', (code) => resolve(code === 0 ? stdout.trim().split(/\r?\n/)[0] || undefined : undefined));
  });
}

async function selfTest(vision: boolean): Promise<boolean> {
  const cfg = loadConfig();
  const log = openLog(cfg);
  // A fresh in-memory cache so the probes really reach Jev and claude.
  const deps = makeDeps(cfg, new MemoryCache(), log);
  const ok = await runSelfTest({
    cfg,
    vision,
    out: (line) => console.log(line),
    classify: deps.classify,
    transcribe: deps.transcribe,
    claudeVersion: () => claudeVersion(cfg.claudePath),
    probePng: Buffer.from(PROBE_PNG_BASE64, 'base64'),
  });
  log.info('selftest.done', { ok, vision });
  return ok;
}

async function host(): Promise<void> {
  let log: Logger = NULL_LOGGER;
  redirectConsole(() => log);
  process.on('uncaughtException', (err) => {
    log.error('host.uncaught', { error: errorText(err) });
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => log.error('host.unhandled_rejection', { error: errorText(reason) }));

  const cfg = loadConfig();
  log = openLog(cfg);
  const cache = new FileCache(path.join(cfg.home, 'cache'), cfg.cacheTtlDays);
  void cache.sweep().then(
    (removed) => log.info('cache.sweep', { removed }),
    (err: unknown) => log.warn('cache.sweep_failed', { error: errorText(err) }),
  );
  log.info('host.start', {
    version: __COMPANION_VERSION__,
    apiKeySource: cfg.apiKeySource,
    claudeFound: !!cfg.claudePath,
    argv: process.argv.slice(2),
  });
  await runHost(process.stdin, process.stdout, makeDeps(cfg, cache, log));
  log.info('host.stop');
  process.exit(0);
}

function exitSoon(code: number): void {
  // Let buffered console output flush; force the exit if something (e.g. a keep-alive socket) lingers.
  process.exitCode = code;
  setTimeout(() => process.exit(code), 1000).unref();
}

const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log(__COMPANION_VERSION__);
} else if (args.includes('--self-test')) {
  selfTest(args.includes('--vision')).then(
    (ok) => exitSoon(ok ? 0 : 1),
    (err: unknown) => {
      console.error(`self-test crashed: ${String((err as Error)?.message ?? err)}`);
      exitSoon(1);
    },
  );
} else {
  void host();
}
