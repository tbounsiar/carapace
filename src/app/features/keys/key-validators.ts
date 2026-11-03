import type { AbstractControl, ValidationErrors, ValidatorFn } from '@angular/forms';
import { TuiValidationError } from '@taiga-ui/cdk';
import type { KeyType } from '../../core/ipc/keys';

export const KEY_NAME_MAX = 64;
export const FILE_NAME_MAX = 64;
export const COMMENT_MAX = 255;
export const PASSPHRASE_MAX = 1024;

const FILE_NAME = /^[A-Za-z0-9_.-]+$/;
const ABSOLUTE_PATH = /^(\/|~\/|[A-Za-z]:[\\/])/;

export const DEFAULT_KEY_NAMES: Readonly<Record<KeyType, string>> = {
  ed25519: 'id_ed25519',
  rsa4096: 'id_rsa',
};

function fail(message: string): ValidationErrors {
  return { invalid: new TuiValidationError(message) };
}

/** Unique among `names()` ignoring case, except `self` (the key being renamed). */
export function keyNameValidator(names: () => readonly string[], self?: string): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const value = String(control.value ?? '').trim();
    if (!value) {
      return fail('Name is required');
    }
    if (value.length > KEY_NAME_MAX) {
      return fail(`Name must be at most ${KEY_NAME_MAX} characters`);
    }
    const lower = value.toLowerCase();
    const taken = names().some(
      (name) => name.toLowerCase() === lower && name.toLowerCase() !== self?.toLowerCase(),
    );
    return taken ? fail('A key with this name already exists') : null;
  };
}

export function fileNameValidator(control: AbstractControl): ValidationErrors | null {
  const value = String(control.value ?? '');
  if (!value) {
    return fail('File name is required');
  }
  if (value.length > FILE_NAME_MAX) {
    return fail(`File name must be at most ${FILE_NAME_MAX} characters`);
  }
  if (value.startsWith('.')) {
    return fail('File name must not start with "."');
  }
  return FILE_NAME.test(value)
    ? null
    : fail('File name may only contain letters, digits, ".", "_" and "-"');
}

/** The file name a key name maps to; may still be invalid (e.g. empty). */
export function fileNameFor(name: string): string {
  return name
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^\.+/, '')
    .slice(0, FILE_NAME_MAX);
}

export function commentValidator(control: AbstractControl): ValidationErrors | null {
  const value = String(control.value ?? '');
  if (value.length > COMMENT_MAX) {
    return fail(`Comment must be at most ${COMMENT_MAX} characters`);
  }
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) < 0x20 || value.charCodeAt(i) === 0x7f) {
      return fail('Comment must be a single line');
    }
  }
  return null;
}

/** Optional; never trimmed or echoed. */
export function passphraseValidator(control: AbstractControl): ValidationErrors | null {
  const length = String(control.value ?? '').length;
  return length > PASSPHRASE_MAX
    ? fail(`Passphrase must be at most ${PASSPHRASE_MAX} characters`)
    : null;
}

export function matchValidator(other: () => string): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null =>
    String(control.value ?? '') === other() ? null : fail('Passphrases do not match');
}

export function keyFilePathValidator(control: AbstractControl): ValidationErrors | null {
  const value = String(control.value ?? '').trim();
  if (!value) {
    return fail('Path is required');
  }
  if (value.startsWith('\\\\')) {
    return fail('Network paths are not supported');
  }
  return ABSOLUTE_PATH.test(value) ? null : fail('Use an absolute path or one starting with ~/');
}

export function keyFolderValidator(control: AbstractControl): ValidationErrors | null {
  const value = String(control.value ?? '').trim();
  if (!value) {
    return fail('Choose a folder for the key.');
  }
  return ABSOLUTE_PATH.test(value) && !value.startsWith('\\\\')
    ? null
    : fail('Use a full path, or one starting with ~/.');
}

export function baseName(path: string): string {
  const parts = path.trim().split(/[\\/]/);
  return parts[parts.length - 1] ?? '';
}
