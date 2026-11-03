import { FormControl, type ValidatorFn } from '@angular/forms';
import {
  baseName,
  commentValidator,
  fileNameFor,
  fileNameValidator,
  keyFilePathValidator,
  keyFolderValidator,
  keyNameValidator,
  matchValidator,
  passphraseValidator,
} from './key-validators';

const ok = (validator: ValidatorFn, value: string): boolean =>
  validator(new FormControl(value)) === null;

describe('key validators', () => {
  it('requires unique key names up to 64 characters, ignoring case', () => {
    const v = keyNameValidator(() => ['Work', 'id_ed25519']);
    expect(ok(v, 'main')).toBe(true);
    expect(ok(v, '  ')).toBe(false);
    expect(ok(v, 'a'.repeat(65))).toBe(false);
    expect(ok(v, 'work')).toBe(false);
    expect(
      ok(
        keyNameValidator(() => ['Work'], 'Work'),
        'WORK',
      ),
    ).toBe(true);
  });

  it('checks file names like the backend', () => {
    expect(ok(fileNameValidator, 'id_ed25519')).toBe(true);
    expect(ok(fileNameValidator, 'my-key.v2')).toBe(true);
    expect(ok(fileNameValidator, '')).toBe(false);
    expect(ok(fileNameValidator, '.hidden')).toBe(false);
    expect(ok(fileNameValidator, 'a/b')).toBe(false);
    expect(ok(fileNameValidator, 'a b')).toBe(false);
    expect(ok(fileNameValidator, 'a'.repeat(65))).toBe(false);
  });

  it('derives a file name from a key name', () => {
    expect(fileNameFor('id_rsa')).toBe('id_rsa');
    expect(fileNameFor(' My key / prod ')).toBe('My-key-prod');
    expect(fileNameFor('..dots')).toBe('dots');
    expect(fileNameFor('x'.repeat(80))).toHaveLength(64);
  });

  it('keeps comments on one line', () => {
    expect(ok(commentValidator, '')).toBe(true);
    expect(ok(commentValidator, 'me@laptop')).toBe(true);
    expect(ok(commentValidator, 'a\nb')).toBe(false);
    expect(ok(commentValidator, 'a'.repeat(256))).toBe(false);
  });

  it('bounds passphrases and checks the confirmation', () => {
    expect(ok(passphraseValidator, '')).toBe(true);
    expect(ok(passphraseValidator, 'x'.repeat(1024))).toBe(true);
    expect(ok(passphraseValidator, 'x'.repeat(1025))).toBe(false);
    expect(
      ok(
        matchValidator(() => 'pw'),
        'pw',
      ),
    ).toBe(true);
    expect(
      ok(
        matchValidator(() => 'pw'),
        'pW',
      ),
    ).toBe(false);
  });

  it('accepts absolute and ~/ key paths', () => {
    expect(ok(keyFilePathValidator, '~/.ssh/id_ed25519')).toBe(true);
    expect(ok(keyFilePathValidator, 'C:\\keys\\id')).toBe(true);
    expect(ok(keyFilePathValidator, '/home/me/id')).toBe(true);
    expect(ok(keyFilePathValidator, 'id_rsa')).toBe(false);
    expect(ok(keyFilePathValidator, '\\\\server\\share\\id')).toBe(false);
  });

  it('requires a full or ~/ key folder', () => {
    const message = (value: string): string | undefined =>
      keyFolderValidator(new FormControl(value))?.['invalid']?.message;
    expect(message('')).toBe('Choose a folder for the key.');
    expect(message('keys')).toBe('Use a full path, or one starting with ~/.');
    expect(ok(keyFolderValidator, '~/.ssh')).toBe(true);
    expect(ok(keyFolderValidator, 'D:/keys')).toBe(true);
    expect(ok(keyFolderValidator, '/srv/keys')).toBe(true);
  });

  it('takes the base name of both separators', () => {
    expect(baseName('~/.ssh/id_rsa')).toBe('id_rsa');
    expect(baseName('C:\\keys\\work')).toBe('work');
  });
});
