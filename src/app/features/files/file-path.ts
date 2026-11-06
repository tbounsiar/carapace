import type { AbstractControl, ValidationErrors, ValidatorFn } from '@angular/forms';
import { translate } from '@jsverse/transloco';
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

/** `name` inside `dir`: remote paths are POSIX; local ones use `\` under a drive letter. */
export function childPath(dir: string, name: string, side: FileSide): string {
  const separator = side === 'local' && DRIVE.test(dir) ? '\\' : '/';
  return dir.endsWith(separator) ? dir + name : `${dir}${separator}${name}`;
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
    if (value.length === 0) return fail(translate('files.name.required'));
    if (value === '.' || value === '..') return fail(translate('files.name.reserved'));
    if (separator.test(value)) {
      return fail(
        translate(side === 'local' ? 'files.name.noSlashOrBackslash' : 'files.name.noSlash'),
      );
    }
    if (hasControl(value)) return fail(translate('files.name.noControl'));
    if (new TextEncoder().encode(value).length > MAX_NAME_BYTES) {
      return fail(translate('files.name.tooLong', { max: MAX_NAME_BYTES }));
    }
    return null;
  };
}
