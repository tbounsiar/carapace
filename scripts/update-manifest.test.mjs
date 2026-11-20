import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { manifest } from './update-manifest.mjs';

const BASE = 'https://github.com/o/r/releases/download/v1.2.3';
const NOW = new Date('2026-11-20T10:00:00.123Z');

// A minisign key pair in the base64 wrapping Tauri uses, and a signer producing `.sig` contents.
function signer(version = '1.2.3') {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const id = randomBytes(8);
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const wrap = (text) => Buffer.from(text).toString('base64');
  const pubkey = wrap(
    `untrusted comment: minisign public key\n${Buffer.concat([Buffer.from('Ed'), id, raw]).toString('base64')}\n`,
  );
  const signFile = (data, name) => {
    const sig = sign(null, createHash('blake2b512').update(data).digest(), privateKey);
    const comment = `timestamp:1763632800\tfile:${name}${version ? `\tversion:${version}` : ''}`;
    const global = sign(null, Buffer.concat([sig, Buffer.from(comment)]), privateKey);
    return wrap(
      `untrusted comment: signature from tauri secret key\n${Buffer.concat([Buffer.from('ED'), id, sig]).toString('base64')}\ntrusted comment: ${comment}\n${global.toString('base64')}\n`,
    );
  };
  return { pubkey, signFile };
}

function folder(s, files) {
  const dir = mkdtempSync(join(tmpdir(), 'manifest-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
    if (s) writeFileSync(join(dir, `${name}.sig`), s.signFile(Buffer.from(content), name));
  }
  return dir;
}

test('lists each signed file under its bundle key and the first one under the bare key', () => {
  const s = signer();
  const dir = folder(s, {
    'carapace-windows-x64-setup.exe': 'nsis',
    'carapace-windows-x64.msi': 'msi',
    'carapace-macos-arm64.app.tar.gz': 'mac',
  });
  const m = manifest(dir, 'v1.2.3', BASE, s.pubkey, NOW);
  assert.equal(m.version, '1.2.3');
  assert.equal(m.pub_date, '2026-11-20T10:00:00Z');
  assert.equal(m.platforms['windows-x86_64-nsis'].url, `${BASE}/carapace-windows-x64-setup.exe`);
  assert.equal(m.platforms['windows-x86_64-msi'].url, `${BASE}/carapace-windows-x64.msi`);
  assert.equal(m.platforms['windows-x86_64'], m.platforms['windows-x86_64-nsis']);
  assert.equal(m.platforms['darwin-aarch64-app'].url, `${BASE}/carapace-macos-arm64.app.tar.gz`);
  assert.equal(m.platforms['linux-x86_64'], undefined);
});

test('skips files without a signature, such as the dmg', () => {
  const s = signer();
  const dir = folder(s, { 'carapace-linux-x64.deb': 'deb' });
  writeFileSync(join(dir, 'carapace-macos-arm64.dmg'), 'dmg');
  const m = manifest(dir, 'v1.2.3', BASE, s.pubkey, NOW);
  assert.deepEqual(Object.keys(m.platforms), ['linux-x86_64-deb', 'linux-x86_64']);
});

test('refuses a signature from another key, as a placeholder public key would give', () => {
  const dir = folder(signer(), { 'carapace-linux-x64.AppImage': 'app' });
  assert.throws(() => manifest(dir, 'v1.2.3', BASE, signer().pubkey, NOW), /another key/);
});

test('refuses a file changed after signing', () => {
  const s = signer();
  const dir = folder(s, { 'carapace-linux-x64.AppImage': 'app' });
  writeFileSync(join(dir, 'carapace-linux-x64.AppImage'), 'tampered');
  assert.throws(() => manifest(dir, 'v1.2.3', BASE, s.pubkey, NOW), /does not verify/);
});

test('refuses a signature not bound to the release version', () => {
  for (const version of [null, '1.2.2']) {
    const s = signer(version);
    const dir = folder(s, { 'carapace-linux-x64.AppImage': 'app' });
    assert.throws(() => manifest(dir, 'v1.2.3', BASE, s.pubkey, NOW), /not bound to version 1.2.3/);
  }
});

test('refuses a tag that is not a plain version, and a folder with nothing signed', () => {
  const s = signer();
  const dir = folder(s, { 'carapace-linux-x64.AppImage': 'app' });
  assert.throws(() => manifest(dir, 'v1.2', BASE, s.pubkey, NOW), /not a release tag/);
  assert.throws(
    () => manifest(folder(null, {}), 'v1.2.3', BASE, s.pubkey, NOW),
    /no signed update file/,
  );
});
