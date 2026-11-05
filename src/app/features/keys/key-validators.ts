import type { AbstractControl, ValidationErrors, ValidatorFn } from '@angular/forms';
import { translate } from '@jsverse/transloco';
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

/** Translated when the control validates; a dialog cannot stay open across a language switch. */
function fail(key: string, params?: Record<string, unknown>): ValidationErrors {
  return { invalid: new TuiValidationError(translate<string>(`keys.validation.${key}`, params)) };
}

/** Unique among `names()` ignoring case, except `self` (the key being renamed). */
export function keyNameValidator(names: () => readonly string[], self?: string): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const value = String(control.value ?? '').trim();
    if (!value) {
      return fail('nameRequired');
    }
    if (value.length > KEY_NAME_MAX) {
      return fail('nameMax', { max: KEY_NAME_MAX });
    }
    const lower = value.toLowerCase();
    const taken = names().some(
      (name) => name.toLowerCase() === lower && name.toLowerCase() !== self?.toLowerCase(),
    );
    return taken ? fail('nameTaken') : null;
  };
}

export function fileNameValidator(control: AbstractControl): ValidationErrors | null {
  const value = String(control.value ?? '');
  if (!value) {
    return fail('fileNameRequired');
  }
  if (value.length > FILE_NAME_MAX) {
    return fail('fileNameMax', { max: FILE_NAME_MAX });
  }
  if (value.startsWith('.')) {
    return fail('fileNameDot');
  }
  return FILE_NAME.test(value) ? null : fail('fileNameChars');
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
    return fail('commentMax', { max: COMMENT_MAX });
  }
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) < 0x20 || value.charCodeAt(i) === 0x7f) {
      return fail('commentLine');
    }
  }
  return null;
}

/** Optional; never trimmed or echoed. */
export function passphraseValidator(control: AbstractControl): ValidationErrors | null {
  const length = String(control.value ?? '').length;
  return length > PASSPHRASE_MAX ? fail('passphraseMax', { max: PASSPHRASE_MAX }) : null;
}

export function matchValidator(other: () => string): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null =>
    String(control.value ?? '') === other() ? null : fail('mismatch');
}

export function keyFilePathValidator(control: AbstractControl): ValidationErrors | null {
  const value = String(control.value ?? '').trim();
  if (!value) {
    return fail('pathRequired');
  }
  if (value.startsWith('\\\\')) {
    return fail('networkPath');
  }
  return ABSOLUTE_PATH.test(value) ? null : fail('pathAbsolute');
}

export function keyFolderValidator(control: AbstractControl): ValidationErrors | null {
  const value = String(control.value ?? '').trim();
  if (!value) {
    return fail('folderRequired');
  }
  return ABSOLUTE_PATH.test(value) && !value.startsWith('\\\\') ? null : fail('folderAbsolute');
}

export function baseName(path: string): string {
  const parts = path.trim().split(/[\\/]/);
  return parts[parts.length - 1] ?? '';
}
