import { TestBed } from '@angular/core/testing';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { ClipboardText } from './clipboard-text';

describe('ClipboardText', () => {
  let calls: { cmd: string; args: unknown }[];

  beforeEach(() => {
    calls = [];
    mockIPC((cmd, args) => {
      calls.push({ cmd, args });
      return cmd === 'plugin:clipboard-manager|read_text' ? 'ls -la' : null;
    });
  });

  afterEach(() => clearMocks());

  it('reads and writes plain text through the plugin', async () => {
    const service = TestBed.inject(ClipboardText);
    await expect(service.read()).resolves.toBe('ls -la');
    await service.write('uptime');
    expect(calls.map((c) => c.cmd)).toEqual([
      'plugin:clipboard-manager|read_text',
      'plugin:clipboard-manager|write_text',
    ]);
    expect(calls[1].args).toMatchObject({ text: 'uptime' });
  });
});
