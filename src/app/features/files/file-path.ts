import type { AbstractControl, ValidationErrors, ValidatorFn } from '@angular/forms';
import { TuiValidationError } from '@taiga-ui/cdk';
import type { FileSide } from '../../core/ipc/files';

export interface Crumb {
  label: string;
  path: string;
}

const DRIVE = /^([A-Za-z]:)[\\/]?/;

/** The local roots listing (drives on Windows) is the `""` path. */
export const ROOTS_LABEL = 'Computer';

export function crumbs(path: string, side: FileSide): Crumb[] {
  const drive = side === 'local' ? DRIVE.exec(path) : null;
  if (drive) {
    const root = `${drive[1]}\\`;
    const result: Crumb[] = [
      { label: ROOTS_LABEL, path: '' },
      { label: drive[1], path: root },
    ];
    let current = root;
    for (const part of path.slice(drive[0].length).split(/[\\/]/).filter(Boolean)) {
      current = current.endsWith('\\') ? current + part : `${current}\\${part}`;
      result.push({ label: part, path: current });
    }
    return result;
  }
  if (path === '') {
    return side === 'local' ? [{ label: ROOTS_LABEL, path: '' }] : [];
  }
  const result: Crumb[] = [{ label: '/', path: '/' }];
  let current = '';
  for (const part of path.split('/').filter(Boolean)) {
    current = `${current}/${part}`;
    result.push({ label: part, path: current });
  }
  return result;
}

/** The parent from the listing, or the roots listing above a local drive root. */
export function upTarget(path: string, parent: string | null, side: FileSide): string | null {
  if (parent !== null) return parent;
  return side === 'local' && DRIVE.test(path) ? '' : null;
}

// Mirrors the backend rules: 1..=255 bytes, no separator, not "." or "..", no control characters.
const hasControl = (value: string): boolean =>
  Array.from(value).some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);
const MAX_NAME_BYTES = 255;

export function fileNameValidator(side: FileSide): ValidatorFn {
  const separator = side === 'local' ? /[\\/]/ : /\//;
  return (control: AbstractControl): ValidationErrors | null => {
    const value = String(control.value ?? '');
    const fail = (message: string): ValidationErrors => ({
      invalid: new TuiValidationError(message),
    });
    if (value.length === 0) return fail('Name is required');
    if (value === '.' || value === '..') return fail('This name is reserved');
    if (separator.test(value)) {
      return fail(side === 'local' ? 'Name must not contain / or \\' : 'Name must not contain /');
    }
    if (hasControl(value)) return fail('Name must not contain control characters');
    if (new TextEncoder().encode(value).length > MAX_NAME_BYTES) {
      return fail(`Name must be at most ${MAX_NAME_BYTES} bytes`);
    }
    return null;
  };
}
