import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { describeUrl, findSessionRestoreData, isDefaultUserDataDir, isHomeUrl, onlyOnHome } from '../../scripts/lib/live-guards.mjs';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lc-guards-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const put = (rel: string, content = '') => {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
};
const prefs = (profile: string, restore: number) => put(`${profile}/Preferences`, JSON.stringify({ session: { restore_on_startup: restore } }));

describe('findSessionRestoreData', () => {
  it('is empty for a missing or fresh dir and for a copy that opens the New Tab page', () => {
    expect(findSessionRestoreData(join(root, 'nope'))).toEqual([]);
    expect(findSessionRestoreData(root)).toEqual([]);
    mkdirSync(join(root, 'Default', 'Sessions'), { recursive: true });
    prefs('Default', 5);
    put('Profile 1/Preferences', '{}');
    expect(findSessionRestoreData(root)).toEqual([]);
  });
  it('flags session files in Default and Profile * dirs', () => {
    put('Default/Sessions/x');
    put('Profile 2/Sessions/Session_1');
    put('Profile 2/Sessions/Tabs_1');
    expect(findSessionRestoreData(root)).toEqual(['Default/Sessions (1 file)', 'Profile 2/Sessions (2 files)']);
  });
  it('flags Chrome 154+ encrypted session files (Sessions_Encrypted) like Sessions', () => {
    mkdirSync(join(root, 'Profile 1', 'Sessions_Encrypted'), { recursive: true });
    expect(findSessionRestoreData(root)).toEqual([]);
    put('Default/Sessions_Encrypted/Session_1');
    put('Profile 1/Sessions_Encrypted/Tabs_1');
    put('Profile 1/Sessions_Encrypted/Session_2');
    expect(findSessionRestoreData(root)).toEqual(['Default/Sessions_Encrypted (1 file)', 'Profile 1/Sessions_Encrypted (2 files)']);
  });
  it('flags non-empty pinned tabs', () => {
    put('Default/Preferences', JSON.stringify({ pinned_tabs: [] }));
    put('Profile 1/Preferences', JSON.stringify({ pinned_tabs: [{ url: 'https://x.com/messages' }] }));
    expect(findSessionRestoreData(root)).toEqual(['Profile 1/Preferences pinned_tabs (1)']);
  });
  it('flags legacy session and tab files', () => {
    for (const f of ['Current Session', 'Current Tabs', 'Last Session', 'Last Tabs']) put(`Default/${f}`);
    expect(findSessionRestoreData(root)).toEqual(['Default/Current Session', 'Default/Current Tabs', 'Default/Last Session', 'Default/Last Tabs']);
  });
  it('flags restoring startup preferences (1 and 4) and unreadable Preferences', () => {
    prefs('Default', 1);
    prefs('Profile 1', 4);
    put('Profile 3/Preferences', '{not json');
    expect(findSessionRestoreData(root)).toEqual([
      'Default/Preferences session.restore_on_startup = 1',
      'Profile 1/Preferences session.restore_on_startup = 4',
      'Profile 3/Preferences (unreadable, cannot rule out session restore)',
    ]);
  });
  it('ignores dirs that are not profiles', () => {
    put('System Profile/Sessions/x');
    put('Crashpad/Last Session');
    expect(findSessionRestoreData(root)).toEqual([]);
  });
  it('refuses without deleting anything', () => {
    put('Default/Sessions/x');
    put('Default/Last Tabs');
    findSessionRestoreData(root);
    expect(findSessionRestoreData(root)).toEqual(['Default/Sessions (1 file)', 'Default/Last Tabs']);
  });
});

describe('isDefaultUserDataDir', () => {
  const env = () => ({ localAppData: join(root, 'Local'), home: join(root, 'home') });
  it('refuses the default dir and anything inside it', () => {
    expect(isDefaultUserDataDir(join(root, 'Local', 'Google', 'Chrome', 'User Data'), env())).toBe(true);
    expect(isDefaultUserDataDir(join(root, 'Local', 'Google', 'Chrome', 'User Data', 'Default') + '/', env())).toBe(true);
    expect(isDefaultUserDataDir(join(root, 'home', '.config', 'google-chrome'), env())).toBe(true);
  });
  it('allows copies next to it', () => {
    expect(isDefaultUserDataDir(join(root, 'Local', 'Google', 'Chrome', 'User Data Copy'), env())).toBe(false);
    expect(isDefaultUserDataDir(join(root, 'lc-copy'), env())).toBe(false);
  });
  it.runIf(process.platform === 'win32')('is case-insensitive on Windows', () => {
    expect(isDefaultUserDataDir(join(root, 'Local', 'GOOGLE', 'chrome', 'user data'), env())).toBe(true);
  });
});

describe('urls', () => {
  it('only https://x.com/home is home', () => {
    expect(isHomeUrl('https://x.com/home')).toBe(true);
    expect(isHomeUrl('https://x.com/home?foo=1')).toBe(true);
    expect(isHomeUrl('https://x.com/messages')).toBe(false);
    expect(isHomeUrl('https://twitter.com/home')).toBe(false);
    expect(isHomeUrl('http://x.com/home')).toBe(false);
    expect(isHomeUrl('about:blank')).toBe(false);
  });
  it('onlyOnHome runs the page expression only on https://x.com/home', () => {
    const run = (href: string) => {
      const u = new URL(href);
      return new Function('location', `return ${onlyOnHome("['collected']", '[]')};`)({ origin: u.origin, pathname: u.pathname });
    };
    expect(run('https://x.com/home')).toEqual(['collected']);
    expect(run('https://x.com/home?x=1')).toEqual(['collected']);
    expect(run('https://x.com/messages/1-2')).toEqual([]);
    expect(run('https://x.com/dave/status/1')).toEqual([]);
    expect(run('https://twitter.com/home')).toEqual([]);
  });
  it('live-x-check guards both page reads (collect → [], snapshot → null) with onlyOnHome', () => {
    const src = readFileSync(join(__dirname, '../../scripts/live-x-check.mjs'), 'utf8');
    expect(src).toContain('const COLLECT_EXPRESSION = onlyOnHome(`(() => {');
    expect(src).toContain("  return out;\n})()`, '[]');");
    expect(src).toContain(`onlyOnHome(\`document.querySelector('[data-testid="primaryColumn"]')?.outerHTML ?? ''\`, 'null')`);
  });
  it('describeUrl prints scheme, host and first path segment only', () => {
    expect(describeUrl('https://x.com/messages/123-456?x=1#y')).toBe('https://x.com/messages');
    expect(describeUrl('https://x.com/i/flow/login')).toBe('https://x.com/i');
    expect(describeUrl('chrome-error://chromewebdata/')).toBe('chrome-error://chromewebdata/');
    expect(describeUrl('https://user:pw@x.com/')).toBe('https://x.com/');
    expect(describeUrl('data:text/html,secret')).toBe('data:');
    expect(describeUrl('not a url')).toBe('(unparseable url)');
  });
});
