import { TestBed } from '@angular/core/testing';
import { ThemeService } from '../theme/theme';
import { FONT_SIZE_STORAGE, KEY_TYPE_STORAGE, Settings } from './settings';

describe('Settings', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const create = () => TestBed.inject(Settings);

  it('starts with the defaults', () => {
    const settings = create();
    expect(settings.defaultKeyType()).toBe('ed25519');
    expect(settings.terminalFontSize()).toBe(13);
    expect(settings.theme()).toBe('system');
  });

  it('persists and restores the key type and font size', () => {
    const settings = create();
    settings.setDefaultKeyType('rsa4096');
    settings.setTerminalFontSize(18);
    expect(localStorage.getItem(KEY_TYPE_STORAGE)).toBe('rsa4096');
    expect(localStorage.getItem(FONT_SIZE_STORAGE)).toBe('18');

    TestBed.resetTestingModule();
    const restored = create();
    expect(restored.defaultKeyType()).toBe('rsa4096');
    expect(restored.terminalFontSize()).toBe(18);
  });

  it('falls back to defaults on invalid stored values', () => {
    localStorage.setItem(KEY_TYPE_STORAGE, 'dsa');
    localStorage.setItem(FONT_SIZE_STORAGE, '99');
    const settings = create();
    expect(settings.defaultKeyType()).toBe('ed25519');
    expect(settings.terminalFontSize()).toBe(13);
  });

  it.each([9, 25, 12.5, null, Number.NaN])('ignores the font size %s', (size) => {
    const settings = create();
    settings.setTerminalFontSize(size);
    expect(settings.terminalFontSize()).toBe(13);
    expect(localStorage.getItem(FONT_SIZE_STORAGE)).toBeNull();
  });

  it('accepts both ends of the font size range', () => {
    const settings = create();
    settings.setTerminalFontSize(10);
    expect(settings.terminalFontSize()).toBe(10);
    settings.setTerminalFontSize(24);
    expect(settings.terminalFontSize()).toBe(24);
  });

  it('uses the defaults when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const settings = create();
    expect(settings.defaultKeyType()).toBe('ed25519');
    settings.setDefaultKeyType('rsa4096');
    expect(settings.defaultKeyType()).toBe('rsa4096');
  });

  it('delegates the theme to the theme service', () => {
    const settings = create();
    settings.setTheme('dark');
    expect(TestBed.inject(ThemeService).mode()).toBe('dark');
    expect(settings.theme()).toBe('dark');
    expect(localStorage.getItem('carapace.theme')).toBe('dark');
  });
});
