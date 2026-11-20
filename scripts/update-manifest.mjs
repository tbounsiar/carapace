// Builds the updater manifest (latest.json) from the signed release files in a folder, after checking
// every signature against the updater public key in tauri.conf.json.
// Usage: node update-manifest.mjs <dir> <tag> <download base URL> <tauri.conf.json>
import { createHash, createPublicKey, verify } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Release file suffix -> bundle type, per build of the release matrix. The updater looks up
// `os-arch-bundle` first, then `os-arch`; the first file of each platform also gets the bare key.
const TARGETS = [
  [
    'windows-x64',
    'windows-x86_64',
    [
      ['-setup.exe', 'nsis'],
      ['.msi', 'msi'],
    ],
  ],
  ['windows-arm64', 'windows-aarch64', [['-setup.exe', 'nsis']]],
  ['macos-arm64', 'darwin-aarch64', [['.app.tar.gz', 'app']]],
  ['macos-x64', 'darwin-x86_64', [['.app.tar.gz', 'app']]],
  [
    'linux-x64',
    'linux-x86_64',
    [
      ['.AppImage', 'appimage'],
      ['.deb', 'deb'],
      ['.rpm', 'rpm'],
    ],
  ],
  [
    'linux-arm64',
    'linux-aarch64',
    [
      ['.AppImage', 'appimage'],
      ['.deb', 'deb'],
      ['.rpm', 'rpm'],
    ],
  ],
];

const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex');

// Tauri stores minisign texts base64-encoded; the key or signature line is the second line.
function minisignLines(b64) {
  return Buffer.from(b64.trim(), 'base64').toString('utf8').split(/\r?\n/);
}

export function publicKey(b64) {
  const raw = Buffer.from(minisignLines(b64)[1] ?? '', 'base64');
  if (raw.length !== 42 || raw.subarray(0, 2).toString() !== 'Ed')
    throw new Error('bad public key');
  return {
    id: raw.subarray(2, 10),
    key: createPublicKey({
      key: Buffer.concat([ED25519_SPKI, raw.subarray(10)]),
      format: 'der',
      type: 'spki',
    }),
  };
}

export function checkSignature(pub, sigB64, data, file, version) {
  const [, sigLine, trusted, globalLine] = minisignLines(sigB64);
  const sig = Buffer.from(sigLine ?? '', 'base64');
  const alg = sig.subarray(0, 2).toString();
  if (sig.length !== 74 || (alg !== 'ED' && alg !== 'Ed'))
    throw new Error(`${file}: bad signature`);
  if (!sig.subarray(2, 10).equals(pub.id)) {
    throw new Error(`${file}: signed with another key than the one in tauri.conf.json`);
  }
  const signed = alg === 'ED' ? createHash('blake2b512').update(data).digest() : data;
  const comment = (trusted ?? '').replace(/^trusted comment: /, '');
  const ok =
    verify(null, signed, pub.key, sig.subarray(10)) &&
    verify(
      null,
      Buffer.concat([sig.subarray(10), Buffer.from(comment)]),
      pub.key,
      Buffer.from(globalLine ?? '', 'base64'),
    );
  if (!ok) throw new Error(`${file}: signature does not verify`);
  // The app sets requireSignedVersion, so it would refuse a signature not bound to this version.
  const bound = comment.split('\t').find((pair) => pair.startsWith('version:'));
  if (bound?.slice('version:'.length) !== version) {
    throw new Error(`${file}: signature not bound to version ${version}`);
  }
}

export function manifest(dir, tag, base, pubkey, now = new Date()) {
  const version = tag.replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`not a release tag: ${tag}`);
  const pub = publicKey(pubkey);
  const platforms = {};
  for (const [name, key, files] of TARGETS) {
    for (const [suffix, bundle] of files) {
      const file = `carapace-${name}${suffix}`;
      if (!existsSync(join(dir, `${file}.sig`))) continue;
      const signature = readFileSync(join(dir, `${file}.sig`), 'utf8').trim();
      checkSignature(pub, signature, readFileSync(join(dir, file)), file, version);
      const entry = { signature, url: `${base}/${file}` };
      platforms[`${key}-${bundle}`] = entry;
      platforms[key] ??= entry;
    }
  }
  if (Object.keys(platforms).length === 0) throw new Error(`no signed update file in ${dir}`);
  return {
    version,
    pub_date: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    platforms,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [dir, tag, base, conf] = process.argv.slice(2);
  const pubkey = JSON.parse(readFileSync(conf, 'utf8')).plugins?.updater?.pubkey;
  if (!pubkey) throw new Error(`no plugins.updater.pubkey in ${conf}`);
  process.stdout.write(`${JSON.stringify(manifest(dir, tag, base, pubkey), null, 2)}\n`);
}
