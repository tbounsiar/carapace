import { TestBed } from '@angular/core/testing';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { IpcError } from './ipc-error';
import { KeyFilePicker } from './key-file-picker';

describe('KeyFilePicker', () => {
  let picker: KeyFilePicker;
  let calls: { cmd: string; args: unknown }[];
  let onCall: (cmd: string) => unknown;

  beforeEach(() => {
    calls = [];
    onCall = () => null;
    mockIPC((cmd, args) => {
      calls.push({ cmd, args });
      return onCall(cmd);
    });
    picker = TestBed.inject(KeyFilePicker);
  });

  afterEach(() => clearMocks());

  it('opens the folder and file pickers with the start hint', async () => {
    onCall = (cmd) => (cmd === 'pick_key_folder' ? 'C:\\keys' : null);
    expect(await picker.pickFolder('C:\\old')).toBe('C:\\keys');
    expect(await picker.pickFile(null)).toBeNull();
    expect(calls).toEqual([
      { cmd: 'pick_key_folder', args: { current: 'C:\\old' } },
      { cmd: 'pick_key_file', args: { current: null } },
    ]);
  });

  it('is picking while a picker is open and refuses a second one', async () => {
    let resolve: (value: string) => void = () => undefined;
    onCall = () => new Promise<string>((r) => (resolve = r));
    const first = picker.pickFile(null);
    expect(picker.picking()).toBe(true);
    expect(await picker.pickFile(null)).toBeNull();
    expect(calls.length).toBe(1);
    resolve('/home/me/.ssh/id');
    expect(await first).toBe('/home/me/.ssh/id');
    expect(picker.picking()).toBe(false);
  });

  it('treats busy as a cancel and rethrows other errors', async () => {
    onCall = () => {
      throw { code: 'busy', message: 'a picker is already open' };
    };
    expect(await picker.pickFolder(null)).toBeNull();
    onCall = () => {
      throw { code: 'io', message: 'no display' };
    };
    await expect(picker.pickFolder(null)).rejects.toBeInstanceOf(IpcError);
    expect(picker.picking()).toBe(false);
  });
});
