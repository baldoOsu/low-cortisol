// Creates the dev/prod RSA keypairs once and keeps only the public keys (they pin the extension IDs).
// The private keys are discarded: load-unpacked needs no signing. Usage: node scripts/gen-keys.mjs [--force]
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extensionIdFromPublicKey } from './lib/manifest.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const keysDir = join(root, 'extension', 'keys');
const force = process.argv.includes('--force');

mkdirSync(keysDir, { recursive: true });
for (const flavor of ['dev', 'prod']) {
  const file = join(keysDir, `${flavor}.pub.b64`);
  if (existsSync(file) && !force) {
    console.log(`${flavor}: ${file} exists, skipping (use --force to regenerate; this changes the extension id)`);
    continue;
  }
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const b64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  writeFileSync(file, b64);
  console.log(`${flavor}: wrote ${file}, extension id ${extensionIdFromPublicKey(b64)}`);
}
