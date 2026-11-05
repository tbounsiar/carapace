import { TestBed } from '@angular/core/testing';
import { TranslocoService } from '@jsverse/transloco';
import { isBackendText } from '../core/ipc/backend-text';
import { textOf } from './backend-text';

describe('textOf', () => {
  beforeEach(() => TestBed.inject(TranslocoService));

  it('translates a key with its params', () => {
    expect(
      textOf({
        key: 'errors.files.notFound',
        params: { path: '/etc/x' },
        message: 'unused',
      }),
    ).toBe('/etc/x was not found');
  });

  it('keeps braces and references of a param verbatim', () => {
    expect(
      textOf({
        key: 'errors.files.notFound',
        params: { path: '/srv/${env}/{a}' },
        message: 'unused',
      }),
    ).toBe('/srv/${env}/{a} was not found');
  });

  it('shows the English message without a key or for an unknown key', () => {
    expect(textOf({ message: 'plain text' })).toBe('plain text');
    expect(textOf({ key: 'errors.nowhere.missing', message: 'fallback' })).toBe('fallback');
  });

  it('translates nested texts and lists first', () => {
    const portRange = {
      key: 'errors.config.portRange',
      params: { min: 1, max: 65535 },
      message: 'port must be between 1 and 65535',
    };
    const whitespace = {
      key: 'errors.config.fieldWhitespace',
      params: { field: 'hostname' },
      message: 'hostname must not contain whitespace or control characters',
    };
    expect(
      textOf({
        key: 'errors.config.invalidFields',
        params: { errors: [whitespace, portRange] },
        message: 'unused',
      }),
    ).toBe(
      'hostname must not contain whitespace or control characters; port must be between 1 and 65535',
    );
    expect(
      textOf({
        key: 'errors.dataTransfer.invalidFile',
        params: { errors: [portRange, portRange] },
        message: 'unused',
      }),
    ).toBe('port must be between 1 and 65535\nport must be between 1 and 65535');
    expect(
      textOf({
        key: 'errors.dataTransfer.inFile',
        params: { file: 'a.json', error: { key: 'errors.dataTransfer.notUtf8', message: 'x' } },
        message: 'unused',
      }),
    ).toBe('file “a.json”: The file is not UTF-8 text.');
  });

  it('follows the active language, plurals and selects included', () => {
    TestBed.inject(TranslocoService).setActiveLang('fr');
    expect(
      textOf({
        key: 'errors.dataTransfer.keychainPartlyRemoved',
        params: { count: 2 },
        message: 'unused',
      }),
    ).toContain('2 valeurs secrètes ont déjà été supprimées');
    expect(
      textOf({
        key: 'errors.dataTransfer.importBlocked',
        params: {
          strategy: 'duplicate',
          reasons: [
            {
              key: 'errors.dataTransfer.wouldHaveTooManyKeys',
              params: { count: 3, max: 2 },
              message: 'unused',
            },
          ],
        },
        message: 'unused',
      }),
    ).toMatch(/Garder les deux.*3/u);
    TestBed.inject(TranslocoService).setActiveLang('en');
  });
});

describe('isBackendText', () => {
  it('accepts only a message with an optional string key and object params', () => {
    expect(isBackendText({ message: 'x' })).toBe(true);
    expect(isBackendText({ key: 'k', params: {}, message: 'x' })).toBe(true);
    expect(isBackendText({ key: 1, message: 'x' })).toBe(false);
    expect(isBackendText({ params: [], message: 'x' })).toBe(false);
    expect(isBackendText({ key: 'k' })).toBe(false);
    expect(isBackendText('x')).toBe(false);
  });
});
