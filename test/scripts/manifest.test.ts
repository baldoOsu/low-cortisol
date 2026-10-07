import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { extensionIdFromPublicKey, HOST_NAME, makeManifest } from '../../scripts/lib/manifest.mjs';

describe('manifest', () => {
  const pub = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  it('extension id is 32 chars a-p and stable', () => {
    const id = extensionIdFromPublicKey(pub);
    expect(id).toMatch(/^[a-p]{32}$/);
    expect(extensionIdFromPublicKey(pub)).toBe(id);
  });
  it('known vector: Chrome id algorithm', () => {
    // sha256 of the DER bytes → first 16 bytes → hex → 0-f mapped to a-p
    expect(extensionIdFromPublicKey(Buffer.from('abc').toString('base64'))).toBe('lkhibglpipabmpokebebeanofnkocccd');
  });
  it('dev and prod manifests', () => {
    const d = makeManifest('dev', pub, '0.1.0');
    const p = makeManifest('prod', pub, '0.1.0');
    expect(d.name).toBe('Low Cortisol (Dev)');
    expect(p.name).toBe('Low Cortisol');
    expect(p).toMatchObject({ manifest_version: 3, version: '0.1.0', key: pub, permissions: ['storage', 'nativeMessaging'], host_permissions: ['https://x.com/*', 'https://twitter.com/*', 'https://pbs.twimg.com/*'], background: { service_worker: 'background.js' } });
    expect(p.content_scripts).toEqual([{ matches: ['https://x.com/*', 'https://twitter.com/*'], js: ['content.js'], run_at: 'document_idle' }]);
    expect(JSON.stringify(p)).not.toMatch(/tabs|scripting|downloads|<all_urls>/);
    expect(HOST_NAME).toBe('com.lowcortisol.companion');
  });

  // Additional tests beyond the brief.
  it('matches spec §4.4 exactly', () => {
    const icons = { 16: 'icons/icon-16.png', 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' };
    expect(makeManifest('dev', pub, '1.2.3')).toEqual({
      manifest_version: 3,
      name: 'Low Cortisol (Dev)',
      version: '1.2.3',
      description: 'Hides ragebait on X. Text judged by TypeSafe Jev; images transcribed by your Claude login via a local companion.',
      key: pub,
      permissions: ['storage', 'nativeMessaging'],
      host_permissions: ['https://x.com/*', 'https://twitter.com/*', 'https://pbs.twimg.com/*'],
      background: { service_worker: 'background.js' },
      content_scripts: [{ matches: ['https://x.com/*', 'https://twitter.com/*'], js: ['content.js'], run_at: 'document_idle' }],
      action: { default_popup: 'popup.html', default_title: 'Low Cortisol (Dev)', default_icon: icons },
      icons,
      minimum_chrome_version: '120',
    });
  });
  it('manifests do not share mutable arrays', () => {
    const a = makeManifest('prod', pub, '0.1.0');
    a.permissions.push('tabs');
    expect(makeManifest('prod', pub, '0.1.0').permissions).toEqual(['storage', 'nativeMessaging']);
  });
});
