import type { KeyView } from './keys';

/** Spec fixture. */
export const KEY: KeyView = {
  id: 'k1',
  name: 'id_ed25519',
  path: 'C:\\Users\\me\\.carapace\\keys\\id_ed25519',
  managed: true,
  origin: 'generated',
  algorithm: 'ed25519',
  bits: null,
  publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA carapace',
  fingerprint: 'SHA256:abc',
  comment: 'carapace',
  encrypted: false,
  hasPassphrase: false,
  warning: null,
};

export function key(patch: Partial<KeyView>): KeyView {
  return { ...KEY, ...patch };
}
