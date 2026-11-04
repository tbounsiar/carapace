import { fakeConfig, host, project } from '../../core/ipc/config.fixture';
import { editedFile } from '../../core/ipc/external-edits.fixture';
import {
  deleteLines,
  extensionOf,
  failureReason,
  hostLabel,
  nameList,
  rowAction,
  stateLook,
  uploadBlocker,
} from './edited-view';

describe('edited-view', () => {
  const at = new Date(2026, 10, 4, 14, 2).getTime();

  it('words every state with a shape, never colour alone', () => {
    const look = (patch: Parameters<typeof editedFile>[3]) =>
      stateLook(editedFile('e', 'h', '/a', patch));
    expect(look({ state: 'opening' })).toEqual({ kind: 'loader', word: 'Opening…' });
    expect(look({ state: 'uploading' })).toEqual({ kind: 'loader', word: 'Uploading…' });
    expect(look({}).word).toBe('No changes');
    expect(look({ lastUploadedAt: at }).word).toBe('Uploaded 14:02');
    expect(look({ state: 'conflict' })).toMatchObject({
      kind: 'badge',
      appearance: 'warning',
      icon: '@tui.triangle-alert',
      word: 'Changed on server',
    });
    expect(look({ state: 'failed' })).toMatchObject({ icon: '@tui.circle-x' });
    expect(look({ state: 'waiting' })).toMatchObject({ icon: '@tui.unplug' });
    expect(look({ state: 'disconnected' })).toMatchObject({ kind: 'status', word: 'Disconnected' });
    expect(look({ state: 'recovered', recoveredAt: at }).word).toBe(
      'Not uploaded (from 4 Nov 14:02)',
    );
  });

  it('offers one row action per state needing the user', () => {
    const action = (state: Parameters<typeof editedFile>[3]) =>
      rowAction(editedFile('e', 'h', '/a', state))?.label ?? null;
    expect(action({ state: 'conflict' })).toBe('Resolve');
    expect(action({ state: 'failed' })).toBe('Retry');
    expect(action({ state: 'waiting' })).toBe('Reconnect');
    expect(action({ state: 'recovered' })).toBe('Upload');
    expect(action({})).toBeNull();
  });

  it('names the host with its scope outside Home', () => {
    const config = fakeConfig();
    config.projects.set([project('p1', 'Payments')]);
    config.nodes.set([host('h1', 'vps', 'p1'), host('h2', 'pi')]);
    expect(hostLabel(config as never, 'h1')).toBe('vps (Payments)');
    expect(hostLabel(config as never, 'h2')).toBe('pi');
    expect(hostLabel(config as never, 'gone')).toBeNull();
  });

  it('turns upload error codes into reasons', () => {
    const reason = (code: string) =>
      failureReason(editedFile('e', 'h', '/a', { error: { code, message: 'denied' } }), 'vps');
    expect(reason('permission_denied')).toBe('Permission denied on vps.');
    expect(reason('not_found')).toBe('The folder no longer exists on vps.');
    expect(reason('network')).toBe('Connection lost during the upload.');
    expect(reason('io')).toContain('Denied.');
  });

  it('blocks upload and open when the host is gone or reaches another server', () => {
    const changed = editedFile('e', 'h', '/a', {
      state: 'failed',
      error: { code: 'host_changed', message: '/a was opened from another server' },
    });
    expect(failureReason(changed, 'vps')).toBe('Opened from another server; nothing was sent.');
    expect(uploadBlocker(changed, 'vps')).toBe('Opened from another server');
    const orphan = editedFile('e', 'h', '/a', { state: 'recovered', canUpload: false });
    expect(uploadBlocker(orphan, 'vps')).toBe('vps no longer exists');
    expect(uploadBlocker(editedFile('e', 'h', '/a'), null)).toBe('The host no longer exists');
    expect(uploadBlocker(editedFile('e', 'h', '/a'), 'vps')).toBeNull();
    const blocked = editedFile('e', 'h', '/srv/run.bat', {
      state: 'failed',
      error: { code: 'blocked_type', message: 'run.bat would be run' },
    });
    expect(uploadBlocker(blocked, 'vps')).toBe('Your system would run this file');
    expect(failureReason(blocked, 'vps')).toBe(
      'run.bat would be run, not opened, by your system. Choose an editor app in Settings to edit .bat files.',
    );
    expect(rowAction(blocked)?.label).toBe('Retry');
  });

  it('builds the delete confirm lines and short name lists', () => {
    expect(deleteLines([])).toBe('');
    expect(deleteLines([editedFile('e', 'h', '/a.env', { notUploaded: true })])).toBe(
      ' 1 file open in an external editor will stop syncing. Changes not uploaded in a.env will be lost.',
    );
    expect(nameList(['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toBe('a, b, c, d, e and 2 more');
    expect(extensionOf('run.ps1')).toBe('ps1');
    expect(extensionOf('.env')).toBe('');
  });
});
