import { TestBed } from '@angular/core/testing';
import { FormControl } from '@angular/forms';
import { TranslocoService } from '@jsverse/transloco';
import { trackLanguage } from '../../shared/ui-text';
import {
  hostnameValidator,
  keyPathValidator,
  nameValidator,
  noWhitespaceValidator,
  portTemplateValidator,
  portValidator,
  secretReferenceValidator,
  secretValidator,
  templated,
  validationMessage,
} from './validators';

const ok = (fn: (c: FormControl) => unknown, value: unknown): boolean =>
  fn(new FormControl(value)) === null;

describe('form validators', () => {
  // The global `translate` behind `uiText` needs the service to exist.
  beforeEach(() => TestBed.inject(TranslocoService));

  it('validates names between 1 and 100 characters', () => {
    const v = nameValidator('Name', 100);
    expect(ok(v, 'prod')).toBe(true);
    expect(ok(v, 'a'.repeat(100))).toBe(true);
    expect(ok(v, '')).toBe(false);
    expect(ok(v, '   ')).toBe(false);
    expect(ok(v, 'a'.repeat(101))).toBe(false);
  });

  it('validates hostname and username without whitespace within the limit', () => {
    const host = noWhitespaceValidator('Hostname', 253);
    expect(ok(host, 'example.com')).toBe(true);
    expect(ok(host, 'a'.repeat(253))).toBe(true);
    expect(ok(host, 'a'.repeat(254))).toBe(false);
    expect(ok(host, '')).toBe(false);
    expect(ok(host, 'my host')).toBe(false);
    const user = noWhitespaceValidator('Username', 64);
    expect(ok(user, 'a'.repeat(64))).toBe(true);
    expect(ok(user, 'a'.repeat(65))).toBe(false);
    expect(ok(user, 'a\tb')).toBe(false);
  });

  it('validates literal ports between 1 and 65535', () => {
    expect(ok(portValidator, '22')).toBe(true);
    expect(ok(portValidator, '1')).toBe(true);
    expect(ok(portValidator, '65535')).toBe(true);
    expect(ok(portValidator, '0')).toBe(false);
    expect(ok(portValidator, '65536')).toBe(false);
    expect(ok(portValidator, '22.5')).toBe(false);
    expect(ok(portValidator, '')).toBe(false);
  });

  it('accepts a port of digits or a single reference', () => {
    expect(ok(portTemplateValidator, '${port}')).toBe(true);
    expect(ok(portTemplateValidator, '2222')).toBe(true);
    expect(ok(portTemplateValidator, '2${port}')).toBe(false);
    expect(ok(portTemplateValidator, 'abc')).toBe(false);
    expect(ok(portTemplateValidator, '${bad name}')).toBe(false);
  });

  it('defers literal rules for templates, bounds their size and rejects bad references', () => {
    const host = templated('Hostname', hostnameValidator(253));
    expect(ok(host, '${bad name}.example.com')).toBe(false);
    expect(ok(host, '${open.example.com')).toBe(false);
    expect(ok(templated('Username', noWhitespaceValidator('Username', 64)), '$${user}')).toBe(true);
    expect(ok(host, '${zone}.example.com')).toBe(true);
    expect(ok(host, '${a}' + 'x'.repeat(1021))).toBe(false);
    expect(ok(templated('Key path', keyPathValidator), '${keys}/id')).toBe(true);
  });

  it('accepts an empty secret field or a single reference', () => {
    const v = secretReferenceValidator('Password');
    expect(ok(v, null)).toBe(true);
    expect(ok(v, '')).toBe(true);
    expect(ok(v, '${db_pw}')).toBe(true);
    expect(ok(v, 'hunter2')).toBe(false);
    expect(ok(v, '${a}${b}')).toBe(false);
  });

  it('requires a non-blank key path', () => {
    expect(ok(keyPathValidator, '~/.ssh/id_ed25519')).toBe(true);
    expect(ok(keyPathValidator, ' ')).toBe(false);
    expect(ok(keyPathValidator, '/home/u/.ssh/id')).toBe(true);
    expect(
      validationMessage(keyPathValidator(new FormControl('~/.ssh/id_work.PUB'))?.['invalid']),
    ).toBe('This is a public key. Choose the file without .pub.');
    expect(ok(keyPathValidator, 'C:\\Users\\u\\.ssh\\id')).toBe(true);
    expect(ok(keyPathValidator, 'id_ed25519')).toBe(false);
    expect(ok(keyPathValidator, '\\\\server\\share\\id')).toBe(false);
  });

  it('restricts hostname characters', () => {
    const v = hostnameValidator(253);
    expect(ok(v, 'web-1.example.com')).toBe(true);
    expect(ok(v, '2001:db8::1')).toBe(true);
    expect(ok(v, 'bad_host')).toBe(false);
    expect(ok(v, 'a/b')).toBe(false);
    expect(ok(v, '-oProxy=x y')).toBe(false);
    expect(ok(v, '')).toBe(false);
  });

  it('validates secrets by length only', () => {
    const required = secretValidator('Password', true);
    const optional = secretValidator('Password', false);
    expect(ok(required, '')).toBe(false);
    expect(ok(optional, '')).toBe(true);
    expect(ok(required, ' pass word ')).toBe(true);
    expect(ok(optional, 'x'.repeat(1280))).toBe(true);
    expect(ok(optional, 'x'.repeat(1281))).toBe(false);
  });

  it('names the field and follows the language', () => {
    const transloco = TestBed.inject(TranslocoService);
    trackLanguage(transloco);
    const error = nameValidator('Name', 100)(new FormControl(''))?.['invalid'];
    expect(validationMessage(error)).toBe('Name is required');
    transloco.setActiveLang('fr');
    expect(validationMessage(error)).toBe('« Name » est obligatoire');
  });
});
