import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
/** Replace the jsdom document body with the fixture's body (keeps the same `document` object). */
export function loadFixture(name: string): Document {
  const html = readFileSync(resolve(__dirname, '../fixtures/x', name), 'utf8');
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.body.innerHTML = parsed.body.innerHTML;
  return document;
}
