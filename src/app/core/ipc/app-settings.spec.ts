import { TestBed } from '@angular/core/testing';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { type AppPreferences, AppSettings } from './app-settings';
import { IpcError } from './ipc-error';

const STORED: AppPreferences = {
  theme: 'dark',
  language: 'fr',
  defaultKeyType: 'rsa4096',
  terminalFontSize: 16,
  keyFolder: null,
};

describe('AppSettings', () => {
  let service: AppSettings;
  let calls: { cmd: string; args: unknown }[];
  let onCall: (cmd: string) => unknown;

  beforeEach(() => {
    calls = [];
    onCall = () => STORED;
    mockIPC((cmd, args) => {
      calls.push({ cmd, args });
      return onCall(cmd);
    });
    service = TestBed.inject(AppSettings);
  });

  afterEach(() => clearMocks());

  it('reads the settings', async () => {
    expect(await service.read()).toEqual(STORED);
    expect(calls).toEqual([{ cmd: 'app_settings', args: {} }]);
  });

  it('sends a patch and returns the saved settings', async () => {
    expect(await service.update({ terminalFontSize: 16, keyFolder: null })).toEqual(STORED);
    expect(calls).toEqual([
      { cmd: 'update_app_settings', args: { patch: { terminalFontSize: 16, keyFolder: null } } },
    ]);
  });

  it('imports the legacy values', async () => {
    expect(await service.importLegacy({ theme: 'dark' })).toEqual(STORED);
    expect(calls).toEqual([{ cmd: 'import_legacy_settings', args: { values: { theme: 'dark' } } }]);
  });

  it('maps backend errors to IpcError', async () => {
    onCall = () => {
      throw { code: 'corrupt_config', message: 'settings.toml is not valid' };
    };
    const err = await service.read().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IpcError);
    expect((err as IpcError).code).toBe('corrupt_config');
  });
});
