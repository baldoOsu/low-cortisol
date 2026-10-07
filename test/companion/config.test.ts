import { describe, expect, it } from 'vitest';
import { companionHome, findClaude, loadConfig, secretsOf } from '../../companion/src/config';

describe('config', () => {
  it('home: override, windows, posix', () => {
    expect(companionHome({ LOW_CORTISOL_HOME: 'X:\\h' }, 'win32', 'C:\\Users\\o')).toBe('X:\\h');
    expect(companionHome({ LOCALAPPDATA: 'C:\\Users\\o\\AppData\\Local' }, 'win32', 'C:\\Users\\o')).toBe('C:\\Users\\o\\AppData\\Local\\LowCortisol');
    expect(companionHome({}, 'linux', '/home/o')).toBe('/home/o/.local/share/low-cortisol');
  });

  it('key comes from env first, then config file; never from nowhere', () => {
    const files: Record<string, string> = { ['/h/config.json']: JSON.stringify({ typesafeApiKey: 'file-key-123456', jevModel: 'jev-1.13.0' }) };
    const base = { platform: 'linux' as const, homedir: '/home/o', exists: () => false, readFile: (p: string) => files[p.replace(/\\/g, '/')] };
    const a = loadConfig({ ...base, env: { LOW_CORTISOL_HOME: '/h', TYPESAFE_API_KEY: ' env-key-123456 ' } });
    expect(a.apiKeySource).toBe('env');
    expect(a.typesafeApiKey).toBe('env-key-123456');
    expect(a.jevModel).toBe('jev-1.13.0');
    const b = loadConfig({ ...base, env: { LOW_CORTISOL_HOME: '/h' } });
    expect(b.apiKeySource).toBe('file');
    expect(secretsOf(b)).toEqual(['file-key-123456']);
    const c = loadConfig({ ...base, env: { LOW_CORTISOL_HOME: '/nowhere' } });
    expect(c.apiKeySource).toBe('none');
    expect(c).toMatchObject({ jevBaseUrl: 'https://api.typesafe.ai', jevModel: 'jev-latest', claudeEffort: 'low', jevConcurrency: 6, visionConcurrency: 2, cacheTtlDays: 30 });
  });

  it('findClaude: configured, then PATH, then ~/.local/bin', () => {
    const has = (set: string[]) => (p: string) => set.includes(p.replace(/\\/g, '/'));
    const env = { PATH: 'C:\\a;C:\\b' };
    expect(findClaude({ env, platform: 'win32', homedir: 'C:\\U', exists: has(['C:/b/claude.exe']) })).toBe('C:\\b\\claude.exe');
    expect(findClaude({ env, platform: 'win32', homedir: 'C:\\U', exists: has(['C:/U/.local/bin/claude.exe']) })).toBe('C:\\U\\.local\\bin\\claude.exe');
    expect(findClaude({ env, platform: 'win32', homedir: 'C:\\U', exists: has(['D:/c.exe', 'C:/b/claude.exe']), configured: 'D:\\c.exe' })).toBe('D:\\c.exe');
    expect(findClaude({ env, platform: 'win32', homedir: 'C:\\U', exists: () => false })).toBeUndefined();
  });

  it('findClaude: posix PATH split on colon; a missing configured path falls through', () => {
    const exists = (p: string) => p === '/usr/bin/claude';
    expect(findClaude({ env: { PATH: '/bin:/usr/bin' }, platform: 'linux', homedir: '/home/o', exists, configured: '/opt/claude' })).toBe('/usr/bin/claude');
    expect(findClaude({ env: {}, platform: 'linux', homedir: '/home/o', exists: (p) => p === '/home/o/.local/bin/claude' })).toBe('/home/o/.local/bin/claude');
  });

  it('invalid or wrongly-typed config file falls back to defaults and never throws', () => {
    const base = { platform: 'linux' as const, homedir: '/home/o', exists: () => false, env: { LOW_CORTISOL_HOME: '/h' } };
    const bad = loadConfig({ ...base, readFile: () => '{not json' });
    expect(bad).toMatchObject({ home: '/h', apiKeySource: 'none', jevModel: 'jev-latest', jevConcurrency: 6 });
    const typed = loadConfig({ ...base, readFile: () => JSON.stringify({ jevConcurrency: 'lots', cacheTtlDays: -1, typesafeApiKey: '   ', jevModel: 7 }) });
    expect(typed).toMatchObject({ apiKeySource: 'none', jevConcurrency: 6, cacheTtlDays: 30, jevModel: 'jev-latest' });
    expect(typed.typesafeApiKey).toBeUndefined();
    expect(secretsOf(typed)).toEqual([]);
    const throwing = loadConfig({ ...base, readFile: () => { throw new Error('EACCES'); } });
    expect(throwing.apiKeySource).toBe('none');
  });

  it('claudePath comes from the configured file value when it exists', () => {
    const cfg = loadConfig({
      platform: 'win32',
      homedir: 'C:\\U',
      env: { LOW_CORTISOL_HOME: 'C:\\h' },
      readFile: (p) => (p === 'C:\\h\\config.json' ? JSON.stringify({ claudePath: 'D:\\tools\\claude.exe' }) : undefined),
      exists: (p) => p === 'D:\\tools\\claude.exe',
    });
    expect(cfg.claudePath).toBe('D:\\tools\\claude.exe');
  });
});
