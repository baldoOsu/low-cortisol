// `host.cjs --self-test [--vision]`: human-readable health check. Never prints the API key. Spec §5

import type { JevState } from '../../shared/types';
import type { HostDeps } from './host';
import { HostError, type CompanionConfig } from './types';

/** A fixed calm post: a working Jev returns a low ragebait score for it. */
export const SELF_TEST_STATE: JevState = {
  post: { author: '@lowcortisol', text: 'Morning walk by the lake. The ducks were out and the coffee was good.' },
  media_status: 'none',
};

export interface SelfTestOptions {
  cfg: CompanionConfig;
  vision: boolean;
  out: (line: string) => void;
  classify: HostDeps['classify'];
  transcribe: HostDeps['transcribe'];
  claudeVersion: () => Promise<string | undefined>;
  probePng: Buffer;
}

function failure(err: unknown): string {
  if (err instanceof HostError) return err.status !== undefined ? `${err.code} ${err.status}` : err.code;
  return 'INTERNAL';
}

function oneLine(s: string, max: number): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, max);
}

/** True iff the key is present, Jev answers and (with vision) a transcript comes back. */
export async function runSelfTest(o: SelfTestOptions): Promise<boolean> {
  const { cfg, out } = o;
  out('Low Cortisol companion self-test');
  out(`  home: ${cfg.home}`);

  const keyPresent = !!cfg.typesafeApiKey;
  out(`  TYPESAFE_API_KEY: ${keyPresent ? `present (${cfg.apiKeySource})` : 'MISSING'}`);

  let jevOk = false;
  try {
    const r = await o.classify(SELF_TEST_STATE);
    out(`  Jev: OK (${r.model}, ${r.latencyMs} ms, ragebait ${r.answers.ragebait.noul.toFixed(2)})`);
    jevOk = true;
  } catch (err) {
    out(`  Jev: FAILED ${failure(err)}`);
  }

  if (cfg.claudePath) {
    const version = await o.claudeVersion().catch(() => undefined);
    out(`  claude: ${cfg.claudePath} (${version ?? 'version unknown'})`);
  } else {
    out('  claude: NOT FOUND');
  }

  let visionOk = true;
  if (o.vision) {
    visionOk = false;
    try {
      const item = { key: 'selftest/probe', kind: 'image' as const, inQuote: false, mediaType: 'image/png', dataBase64: o.probePng.toString('base64') };
      const r = await o.transcribe([item], 'claude-opus-5-5');
      const t = r.transcripts[0];
      if (!t) throw new HostError('CLAUDE_FAILED', 'no transcript returned');
      const secs = (r.latencyMs / 1000).toFixed(1);
      out(`  Vision: OK (${t.model}, ${secs} s, "${oneLine(t.visibleText || t.description, 40)}")`);
      visionOk = true;
    } catch (err) {
      out(`  Vision: FAILED ${failure(err)}`);
    }
  }

  return keyPresent && jevOk && visionOk;
}
