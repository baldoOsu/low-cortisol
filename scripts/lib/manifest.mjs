// Chrome MV3 manifest for the dev/prod builds, and the pinned extension id. Spec §4.4
import { createHash } from 'node:crypto';

export const HOST_NAME = 'com.lowcortisol.companion';

const DESCRIPTION =
  'Hides ragebait on X. Text judged by TypeSafe Jev; images transcribed by your Claude login via a local companion.';

/** Chrome's id algorithm: sha256(DER public key) → first 32 hex chars → each 0-f mapped to a-p. */
export function extensionIdFromPublicKey(publicKeyB64) {
  const hex = createHash('sha256').update(Buffer.from(publicKeyB64, 'base64')).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

export function makeManifest(flavor, publicKeyB64, version) {
  const name = flavor === 'dev' ? 'Low Cortisol (Dev)' : 'Low Cortisol';
  const icons = () => ({ 16: 'icons/icon-16.png', 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' });
  return {
    manifest_version: 3,
    name,
    version,
    description: DESCRIPTION,
    key: publicKeyB64,
    permissions: ['storage', 'nativeMessaging'],
    host_permissions: ['https://x.com/*', 'https://twitter.com/*', 'https://pbs.twimg.com/*'],
    background: { service_worker: 'background.js' },
    content_scripts: [{ matches: ['https://x.com/*', 'https://twitter.com/*'], js: ['content.js'], run_at: 'document_idle' }],
    action: { default_popup: 'popup.html', default_title: name, default_icon: icons() },
    icons: icons(),
    minimum_chrome_version: '120',
  };
}
