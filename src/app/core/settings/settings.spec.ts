import { TestBed } from '@angular/core/testing';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { TuiNotificationService } from '@taiga-ui/core';
import { of } from 'rxjs';
import type { AppPreferences } from '../ipc/app-settings';
import { LANGUAGE_CACHE, LanguageService } from '../i18n/language';
import { ThemeService } from '../theme/theme';
import {
  FONT_SIZE_STORAGE,
  IMPORTED_STORAGE,
  KEY_FOLDER_STORAGE,
  KEY_TYPE_STORAGE,
  Settings,
} from './settings';

const DEFAULTS: AppPreferences = {
  theme: 'system',
  language: 'system',
  defaultKeyType: 'ed25519',
  terminalFontSize: 13,
  keyFolder: null,
};

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r));
  }
};

describe('Settings', () => {
  let backend: AppPreferences;
  let calls: { cmd: string; args: Record<string, unknown> }[];
  let failing: Set<string>;
  let gate: Promise<void> | null;
  let keepsBackend: boolean;
  const open = vi.fn(() => of());

  beforeEach(() => {
    localStorage.clear();
    backend = { ...DEFAULTS };
    calls = [];
    failing = new Set();
    gate = null;
    keepsBackend = false;
    open.mockClear();
    mockIPC(async (cmd, args) => {
      const payload = (args ?? {}) as Record<string, unknown>;
      calls.push({ cmd, args: payload });
      const fails = failing.has(cmd);
      if (gate) {
        await gate;
      }
      if (fails) {
        throw { code: 'io', message: 'disk full' };
      }
      if (cmd === 'update_app_settings') {
        backend = { ...backend, ...(payload['patch'] as object) };
      }
      if (cmd === 'import_legacy_settings' && !keepsBackend) {
        backend = { ...backend, ...(payload['values'] as object) };
      }
      return backend;
    });
    TestBed.configureTestingModule({
      providers: [{ provide: TuiNotificationService, useValue: { open } }],
    });
  });

  afterEach(() => {
    clearMocks();
    vi.restoreAllMocks();
  });

  const create = () => TestBed.inject(Settings);
  const commands = () => calls.map((c) => c.cmd);
  const restart = () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: TuiNotificationService, useValue: { open } }],
    });
    calls = [];
    return create();
  };

  it('starts with the defaults', () => {
    const settings = create();
    expect(settings.defaultKeyType()).toBe('ed25519');
    expect(settings.terminalFontSize()).toBe(13);
    expect(settings.keyFolder()).toBeNull();
    expect(settings.theme()).toBe('system');
  });

  describe('start', () => {
    it('applies the backend values and refreshes the theme cache', async () => {
      localStorage.setItem(IMPORTED_STORAGE, '1');
      localStorage.setItem('carapace.theme', 'light');
      backend = {
        theme: 'dark',
        language: 'fr',
        defaultKeyType: 'rsa4096',
        terminalFontSize: 18,
        keyFolder: '~/k',
      };
      const settings = create();
      expect(settings.theme()).toBe('light');
      await settings.start();
      expect(commands()).toEqual(['app_settings']);
      expect(settings.theme()).toBe('dark');
      expect(TestBed.inject(ThemeService).effective()).toBe('dark');
      expect(localStorage.getItem('carapace.theme')).toBe('dark');
      expect(settings.defaultKeyType()).toBe('rsa4096');
      expect(settings.terminalFontSize()).toBe(18);
      expect(settings.keyFolder()).toBe('~/k');
      expect(settings.language()).toBe('fr');
      expect(TestBed.inject(LanguageService).active()).toBe('fr');
      expect(localStorage.getItem(LANGUAGE_CACHE)).toBe('fr');
    });

    it('reads an unknown language as system', async () => {
      localStorage.setItem(IMPORTED_STORAGE, '1');
      localStorage.setItem(LANGUAGE_CACHE, 'fr');
      backend = { ...DEFAULTS, language: 'klingon' } as unknown as AppPreferences;
      const settings = create();
      expect(settings.language()).toBe('fr');
      await settings.start();
      expect(settings.language()).toBe('system');
      expect(localStorage.getItem(LANGUAGE_CACHE)).toBe('system');
    });

    it('does not send the language cache as a legacy value', async () => {
      localStorage.setItem('carapace.theme', 'dark');
      localStorage.setItem(LANGUAGE_CACHE, 'fr');
      await create().start();
      expect(calls[0]).toEqual({
        cmd: 'import_legacy_settings',
        args: { values: { theme: 'dark' } },
      });
    });

    it('runs once', async () => {
      const settings = create();
      await Promise.all([settings.start(), settings.start()]);
      expect(commands()).toEqual(['app_settings']);
    });

    it('keeps the cached and default values when the backend cannot be read', async () => {
      localStorage.setItem('carapace.theme', 'dark');
      failing.add('import_legacy_settings');
      failing.add('app_settings');
      const settings = create();
      await expect(settings.start()).resolves.toBeUndefined();
      expect(settings.theme()).toBe('dark');
      expect(settings.terminalFontSize()).toBe(13);
      expect(open).not.toHaveBeenCalled();
    });

    it('ignores invalid backend values', async () => {
      localStorage.setItem(IMPORTED_STORAGE, '1');
      backend = {
        theme: 'purple',
        defaultKeyType: 'dsa',
        terminalFontSize: 99,
        keyFolder: 'relative',
      } as unknown as AppPreferences;
      const settings = create();
      await settings.start();
      expect(settings.theme()).toBe('system');
      expect(settings.defaultKeyType()).toBe('ed25519');
      expect(settings.terminalFontSize()).toBe(13);
      expect(settings.keyFolder()).toBeNull();
    });

    it('does not overwrite a change made before the backend answered', async () => {
      localStorage.setItem(IMPORTED_STORAGE, '1');
      backend = { ...DEFAULTS, terminalFontSize: 20, defaultKeyType: 'rsa4096' };
      let release!: () => void;
      gate = new Promise((r) => (release = r));
      const settings = create();
      const started = settings.start();
      settings.setTerminalFontSize(11);
      release();
      gate = null;
      await started;
      await flush();
      expect(settings.terminalFontSize()).toBe(11);
      expect(settings.defaultKeyType()).toBe('rsa4096');
    });
  });

  describe('legacy import', () => {
    beforeEach(() => {
      localStorage.setItem('carapace.theme', 'dark');
      localStorage.setItem(KEY_TYPE_STORAGE, 'rsa4096');
      localStorage.setItem(FONT_SIZE_STORAGE, '16');
      localStorage.setItem(KEY_FOLDER_STORAGE, 'C:\\keys');
    });

    it('shows the stored values at once, imports them and clears them except the theme cache', async () => {
      const settings = create();
      expect(settings.defaultKeyType()).toBe('rsa4096');
      expect(settings.terminalFontSize()).toBe(16);
      expect(settings.keyFolder()).toBe('C:\\keys');
      await settings.start();
      expect(calls).toEqual([
        {
          cmd: 'import_legacy_settings',
          args: {
            values: {
              theme: 'dark',
              defaultKeyType: 'rsa4096',
              terminalFontSize: 16,
              keyFolder: 'C:\\keys',
            },
          },
        },
      ]);
      expect(localStorage.getItem(KEY_TYPE_STORAGE)).toBeNull();
      expect(localStorage.getItem(FONT_SIZE_STORAGE)).toBeNull();
      expect(localStorage.getItem(KEY_FOLDER_STORAGE)).toBeNull();
      expect(localStorage.getItem('carapace.theme')).toBe('dark');

      const next = restart();
      await next.start();
      expect(commands()).toEqual(['app_settings']);
      expect(next.terminalFontSize()).toBe(16);
    });

    it('shows what the backend kept when it already had values', async () => {
      keepsBackend = true;
      backend = { ...DEFAULTS, terminalFontSize: 20 };
      const settings = create();
      await settings.start();
      expect(settings.terminalFontSize()).toBe(20);
      expect(settings.defaultKeyType()).toBe('ed25519');
      expect(settings.theme()).toBe('system');
      expect(localStorage.getItem('carapace.theme')).toBe('system');
    });

    it('sends only valid values', async () => {
      localStorage.setItem(KEY_TYPE_STORAGE, 'dsa');
      localStorage.setItem(FONT_SIZE_STORAGE, '99');
      localStorage.removeItem(KEY_FOLDER_STORAGE);
      await create().start();
      expect(calls[0]).toEqual({
        cmd: 'import_legacy_settings',
        args: { values: { theme: 'dark' } },
      });
    });

    it('keeps the keys and the stored values on failure and retries next launch', async () => {
      failing.add('import_legacy_settings');
      backend = { ...DEFAULTS, terminalFontSize: 20 };
      const settings = create();
      await settings.start();
      expect(commands()).toEqual(['import_legacy_settings', 'app_settings']);
      expect(settings.terminalFontSize()).toBe(16);
      expect(settings.theme()).toBe('dark');
      expect(localStorage.getItem(FONT_SIZE_STORAGE)).toBe('16');
      expect(localStorage.getItem(IMPORTED_STORAGE)).toBeNull();
      expect(open).not.toHaveBeenCalled();

      failing.clear();
      await restart().start();
      expect(commands()).toEqual(['import_legacy_settings']);
      expect(localStorage.getItem(FONT_SIZE_STORAGE)).toBeNull();
    });

    it('marks a fresh install as imported without a call', async () => {
      localStorage.clear();
      await create().start();
      expect(commands()).toEqual(['app_settings']);
      expect(localStorage.getItem(IMPORTED_STORAGE)).toBe('1');
    });
  });

  describe('writes', () => {
    beforeEach(() => localStorage.setItem(IMPORTED_STORAGE, '1'));

    it('updates the signal at once and saves the patch', async () => {
      const settings = create();
      settings.setDefaultKeyType('rsa4096');
      settings.setTerminalFontSize(18);
      expect(settings.defaultKeyType()).toBe('rsa4096');
      expect(settings.terminalFontSize()).toBe(18);
      await flush();
      expect(calls).toEqual([
        { cmd: 'update_app_settings', args: { patch: { defaultKeyType: 'rsa4096' } } },
        { cmd: 'update_app_settings', args: { patch: { terminalFontSize: 18 } } },
      ]);
      expect(settings.terminalFontSize()).toBe(18);
      expect(localStorage.getItem(FONT_SIZE_STORAGE)).toBeNull();
    });

    it('saves the theme through the backend and the cache', async () => {
      const settings = create();
      settings.setTheme('dark');
      expect(TestBed.inject(ThemeService).mode()).toBe('dark');
      expect(localStorage.getItem('carapace.theme')).toBe('dark');
      await flush();
      expect(calls).toEqual([{ cmd: 'update_app_settings', args: { patch: { theme: 'dark' } } }]);
    });

    it('saves the language through the backend and the cache', async () => {
      const settings = create();
      settings.setLanguage('fr');
      expect(TestBed.inject(LanguageService).active()).toBe('fr');
      expect(localStorage.getItem(LANGUAGE_CACHE)).toBe('fr');
      await flush();
      expect(calls).toEqual([{ cmd: 'update_app_settings', args: { patch: { language: 'fr' } } }]);
    });

    it('reverts the language and its cache on failure', async () => {
      failing.add('update_app_settings');
      const settings = create();
      settings.setLanguage('fr');
      await flush();
      expect(settings.language()).toBe('system');
      expect(localStorage.getItem(LANGUAGE_CACHE)).toBe('system');
      expect(document.documentElement.lang).toBe('en');
    });

    it('merges changes made during a save into the next one', async () => {
      const settings = create();
      let release!: () => void;
      gate = new Promise((r) => (release = r));
      settings.setTerminalFontSize(14);
      settings.setTerminalFontSize(15);
      settings.setTerminalFontSize(16);
      settings.setDefaultKeyType('rsa4096');
      gate = null;
      release();
      await flush();
      expect(calls.map((c) => c.args)).toEqual([
        { patch: { terminalFontSize: 14 } },
        { patch: { terminalFontSize: 16, defaultKeyType: 'rsa4096' } },
      ]);
      expect(settings.terminalFontSize()).toBe(16);
    });

    it('restores the saved value and notifies on failure', async () => {
      backend = { ...DEFAULTS, terminalFontSize: 15 };
      const settings = create();
      await settings.start();
      failing.add('update_app_settings');
      settings.setTerminalFontSize(20);
      expect(settings.terminalFontSize()).toBe(20);
      await flush();
      expect(settings.terminalFontSize()).toBe(15);
      expect(open).toHaveBeenCalledWith(
        expect.stringContaining('Disk full'),
        expect.objectContaining({ label: 'Setting not saved', appearance: 'negative' }),
      );
    });

    it('reverts the theme and its cache on failure', async () => {
      failing.add('update_app_settings');
      const settings = create();
      settings.setTheme('light');
      await flush();
      expect(settings.theme()).toBe('system');
      expect(localStorage.getItem('carapace.theme')).toBe('system');
    });

    it('keeps a newer change when an older save fails', async () => {
      const settings = create();
      let release!: () => void;
      gate = new Promise((r) => (release = r));
      failing.add('update_app_settings');
      settings.setTerminalFontSize(14);
      settings.setTerminalFontSize(18);
      await new Promise((r) => setTimeout(r));
      expect(settings.terminalFontSize()).toBe(18);
      failing.clear();
      gate = null;
      release();
      await flush();
      expect(settings.terminalFontSize()).toBe(18);
      expect(open).toHaveBeenCalledTimes(1);
    });

    it.each([9, 25, 12.5, null, Number.NaN])('ignores the font size %s', async (size) => {
      const settings = create();
      settings.setTerminalFontSize(size);
      await flush();
      expect(settings.terminalFontSize()).toBe(13);
      expect(calls).toEqual([]);
    });

    it('accepts both ends of the font size range', () => {
      const settings = create();
      settings.setTerminalFontSize(10);
      expect(settings.terminalFontSize()).toBe(10);
      settings.setTerminalFontSize(24);
      expect(settings.terminalFontSize()).toBe(24);
    });

    it('saves the key folder, clears it with null and ignores invalid values', async () => {
      const settings = create();
      settings.setKeyFolder('C:\\Users\\me\\.ssh');
      settings.setKeyFolder('relative/dir');
      expect(settings.keyFolder()).toBe('C:\\Users\\me\\.ssh');
      await flush();
      settings.setKeyFolder(null);
      expect(settings.keyFolder()).toBeNull();
      await flush();
      expect(calls.map((c) => c.args)).toEqual([
        { patch: { keyFolder: 'C:\\Users\\me\\.ssh' } },
        { patch: { keyFolder: null } },
      ]);
      expect(localStorage.getItem(KEY_FOLDER_STORAGE)).toBeNull();
    });
  });

  it('works when storage throws', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const settings = create();
    expect(settings.defaultKeyType()).toBe('ed25519');
    await settings.start();
    settings.setDefaultKeyType('rsa4096');
    expect(settings.defaultKeyType()).toBe('rsa4096');
  });
});
