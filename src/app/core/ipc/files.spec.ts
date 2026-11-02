import { TestBed } from '@angular/core/testing';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { FileSources } from './files';
import { IpcError } from './ipc-error';

describe('FileSources', () => {
  let sources: FileSources;
  let calls: { cmd: string; args: unknown }[];
  let reply: (cmd: string) => unknown;

  beforeEach(() => {
    calls = [];
    reply = () => null;
    mockIPC((cmd, args) => {
      calls.push({ cmd, args });
      return reply(cmd);
    });
    sources = TestBed.inject(FileSources);
  });

  afterEach(() => clearMocks());

  it('sends local commands', async () => {
    const local = sources.local;
    reply = (cmd) => (cmd === 'local_home' ? 'C:\\Users\\me' : null);
    expect(await local.home()).toBe('C:\\Users\\me');
    await local.list('C:\\Users');
    await local.mkdir('C:\\Users', 'new');
    await local.rename('C:\\Users\\a', 'b');
    await local.delete('C:\\Users\\b', true);
    expect(calls).toEqual([
      { cmd: 'local_home', args: {} },
      { cmd: 'local_list', args: { path: 'C:\\Users' } },
      { cmd: 'local_mkdir', args: { parent: 'C:\\Users', name: 'new' } },
      { cmd: 'local_rename', args: { path: 'C:\\Users\\a', newName: 'b' } },
      { cmd: 'local_delete', args: { path: 'C:\\Users\\b', recursive: true } },
    ]);
  });

  it('sends remote commands with the connection id', async () => {
    const remote = sources.remote('h1@e1');
    await remote.list('/srv');
    await remote.mkdir('/srv', 'logs');
    await remote.rename('/srv/logs', 'old');
    await remote.delete('/srv/old', false);
    expect(calls).toEqual([
      { cmd: 'sftp_list', args: { connectionId: 'h1@e1', path: '/srv' } },
      { cmd: 'sftp_mkdir', args: { connectionId: 'h1@e1', parent: '/srv', name: 'logs' } },
      { cmd: 'sftp_rename', args: { connectionId: 'h1@e1', path: '/srv/logs', newName: 'old' } },
      { cmd: 'sftp_delete', args: { connectionId: 'h1@e1', path: '/srv/old', recursive: false } },
    ]);
  });

  it('uses the empty path as the remote home without a call', async () => {
    expect(await sources.remote('h1@e1').home()).toBe('');
    expect(calls).toEqual([]);
  });

  it('reuses one remote source per connection', () => {
    expect(sources.remote('h1@e1')).toBe(sources.remote('h1@e1'));
    expect(sources.remote('h1@e1')).not.toBe(sources.remote('h1@none'));
    expect(sources.local.side).toBe('local');
    expect(sources.remote('h1@e1').side).toBe('remote');
  });

  it('maps the new file error codes', async () => {
    reply = () => {
      throw { code: 'permission_denied', message: 'Permission denied: /root' };
    };
    const err = await sources
      .remote('h1@e1')
      .list('/root')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IpcError);
    expect((err as IpcError).code).toBe('permission_denied');
  });
});
