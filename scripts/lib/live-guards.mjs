// Pure guards for scripts/live-x-check.mjs: which profile dirs it may use and which URLs it may be on.
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

const PROFILE_DIR_RE = /^(Default|Profile .+)$/;
const LEGACY_SESSION_FILES = ['Current Session', 'Current Tabs', 'Last Session', 'Last Tabs'];
/** Chrome 154+ keeps its session files encrypted in Sessions_Encrypted instead of Sessions. */
const SESSION_DIRS = ['Sessions', 'Sessions_Encrypted'];
/** session.restore_on_startup: 1 = continue where you left off, 4 = open specific pages. */
const RESTORING_STARTUP = new Set([1, 4]);

function canonical(dir) {
  let p = resolve(dir);
  try {
    p = realpathSync.native(p);
  } catch {
    // Not there yet: Chrome will create it.
  }
  p = p.replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

function defaultUserDataDirs({ localAppData, home }) {
  const local = localAppData || join(home, 'AppData', 'Local');
  const channels = ['Chrome', 'Chrome Beta', 'Chrome Dev', 'Chrome SxS'];
  return [
    ...channels.map((c) => join(local, 'Google', c, 'User Data')),
    join(local, 'Chromium', 'User Data'),
    ...channels.map((c) => join(home, 'Library', 'Application Support', 'Google', c)),
    join(home, '.config', 'google-chrome'),
    join(home, '.config', 'chromium'),
  ];
}

/** True if dir is (or lies inside) a browser's default user data directory. */
export function isDefaultUserDataDir(dir, { localAppData = process.env.LOCALAPPDATA, home = homedir() } = {}) {
  const target = canonical(dir);
  return defaultUserDataDirs({ localAppData, home }).some((d) => {
    const base = canonical(d);
    return target === base || target.startsWith(base + sep);
  });
}

/**
 * Lists what would make Chrome reopen old tabs (possibly /messages) at launch, before the tool can close them:
 * session files (Sessions/ or Sessions_Encrypted/), legacy session/tab files, a restoring "On startup" preference,
 * or pinned tabs. Empty means safe. Never deletes.
 */
export function findSessionRestoreData(userDataDir) {
  if (!existsSync(userDataDir)) return [];
  const found = [];
  const profiles = readdirSync(userDataDir, { withFileTypes: true }).filter((e) => e.isDirectory() && PROFILE_DIR_RE.test(e.name));
  for (const { name } of profiles) {
    const dir = join(userDataDir, name);
    for (const sessionDir of SESSION_DIRS) {
      const sessions = join(dir, sessionDir);
      if (!existsSync(sessions)) continue;
      const files = readdirSync(sessions, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).length;
      if (files > 0) found.push(`${name}/${sessionDir} (${files} file${files === 1 ? '' : 's'})`);
    }
    for (const file of LEGACY_SESSION_FILES) if (existsSync(join(dir, file))) found.push(`${name}/${file}`);
    const prefsPath = join(dir, 'Preferences');
    if (!existsSync(prefsPath)) continue;
    let prefs;
    try {
      prefs = JSON.parse(readFileSync(prefsPath, 'utf8'));
    } catch {
      found.push(`${name}/Preferences (unreadable, cannot rule out session restore)`);
      continue;
    }
    const startup = prefs?.session?.restore_on_startup;
    if (RESTORING_STARTUP.has(startup)) found.push(`${name}/Preferences session.restore_on_startup = ${startup}`);
    // Pinned tabs reopen at launch whatever the startup setting says.
    const pinned = prefs?.pinned_tabs;
    if (Array.isArray(pinned) && pinned.length > 0) found.push(`${name}/Preferences pinned_tabs (${pinned.length})`);
  }
  return found;
}

export function isHomeUrl(url) {
  try {
    const u = new URL(url);
    return u.origin === 'https://x.com' && u.pathname === '/home';
  } catch {
    return false;
  }
}

/** In-page check (Runtime.evaluate) that the tab is on https://x.com/home right now. */
export const IN_PAGE_IS_HOME = "location.origin === 'https://x.com' && location.pathname === '/home'";

/** Wraps a page expression so it only runs on https://x.com/home, else evaluates to `otherwise`. */
export function onlyOnHome(expression, otherwise) {
  return `((${IN_PAGE_IS_HOME}) ? (${expression}) : ${otherwise})`;
}

/** Scheme, host and first path segment only: never a conversation id, a query, or a data: payload. */
export function describeUrl(url) {
  try {
    const u = new URL(url);
    if (!u.host) return u.protocol;
    return `${u.protocol}//${u.host}/${u.pathname.split('/')[1] ?? ''}`;
  } catch {
    return '(unparseable url)';
  }
}
