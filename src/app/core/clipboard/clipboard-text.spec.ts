import { TestBed } from '@angular/core/testing';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import { ClipboardText } from './clipboard-text';

vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  readText: vi.fn(() => Promise.resolve('ls -la')),
  writeText: vi.fn(() => Promise.resolve()),
}));

describe('ClipboardText', () => {
  it('reads and writes plain text through the plugin', async () => {
    const service = TestBed.inject(ClipboardText);
    await expect(service.read()).resolves.toBe('ls -la');
    expect(readText).toHaveBeenCalledOnce();
    await service.write('uptime');
    expect(writeText).toHaveBeenCalledWith('uptime');
  });
});
