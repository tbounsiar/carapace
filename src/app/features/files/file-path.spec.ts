import { TestBed } from '@angular/core/testing';
import { TranslocoService } from '@jsverse/transloco';
import type { AbstractControl } from '@angular/forms';
import { crumbs, fileNameValidator, upTarget } from './file-path';

// The validator translates through Transloco's global service, created on first injection.
beforeEach(() => TestBed.inject(TranslocoService));

describe('crumbs', () => {
  it('splits a POSIX path', () => {
    expect(crumbs('/home/deploy', 'remote')).toEqual([
      { label: '/', path: '/' },
      { label: 'home', path: '/home' },
      { label: 'deploy', path: '/home/deploy' },
    ]);
    expect(crumbs('/', 'remote')).toEqual([{ label: '/', path: '/' }]);
  });

  it('splits a Windows drive path under the roots', () => {
    expect(crumbs('C:\\Users\\me', 'local')).toEqual([
      { label: 'Computer', path: '' },
      { label: 'C:', path: 'C:\\' },
      { label: 'Users', path: 'C:\\Users' },
      { label: 'me', path: 'C:\\Users\\me' },
    ]);
    expect(crumbs('D:\\', 'local')).toEqual([
      { label: 'Computer', path: '' },
      { label: 'D:', path: 'D:\\' },
    ]);
  });

  it('shows the roots listing and Unix local paths', () => {
    expect(crumbs('', 'local')).toEqual([{ label: 'Computer', path: '' }]);
    expect(crumbs('/tmp', 'local')).toEqual([
      { label: '/', path: '/' },
      { label: 'tmp', path: '/tmp' },
    ]);
  });
});

describe('upTarget', () => {
  it('uses the parent, or the roots above a local drive root', () => {
    expect(upTarget('/home', '/', 'remote')).toBe('/');
    expect(upTarget('/', null, 'remote')).toBeNull();
    expect(upTarget('C:\\', null, 'local')).toBe('');
    expect(upTarget('', null, 'local')).toBeNull();
    expect(upTarget('/', null, 'local')).toBeNull();
  });
});

describe('fileNameValidator', () => {
  const check = (side: 'local' | 'remote', value: string): string | null => {
    const result = fileNameValidator(side)({ value } as AbstractControl);
    return result ? (result['invalid'] as { message: string }).message : null;
  };

  it('accepts ordinary names, including spaces and dots', () => {
    expect(check('remote', 'notes.txt')).toBeNull();
    expect(check('remote', ' spaced ')).toBeNull();
    expect(check('remote', '.profile')).toBeNull();
    expect(check('remote', 'a\\b')).toBeNull();
  });

  it('rejects empty, reserved, separators and control characters', () => {
    expect(check('remote', '')).toBe('Name is required');
    expect(check('remote', '.')).toBe('This name is reserved');
    expect(check('remote', '..')).toBe('This name is reserved');
    expect(check('remote', 'a/b')).toContain('must not contain /');
    expect(check('local', 'a\\b')).toContain('\\');
    expect(check('remote', 'a\u0000b')).toContain('control');
    expect(check('remote', 'a\nb')).toContain('control');
  });

  it('limits names to 255 bytes of UTF-8', () => {
    expect(check('remote', 'a'.repeat(255))).toBeNull();
    expect(check('remote', 'a'.repeat(256))).toContain('255 bytes');
    expect(check('remote', 'é'.repeat(128))).toContain('255 bytes');
  });
});
