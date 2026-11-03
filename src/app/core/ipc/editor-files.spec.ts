import { TestBed } from '@angular/core/testing';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { EditorFiles } from './editor-files';
import { IpcError } from './ipc-error';

describe('EditorFiles', () => {
  let files: EditorFiles;
  let calls: { cmd: string; args: unknown }[];
  let reply: (cmd: string) => unknown;

  beforeEach(() => {
    calls = [];
    reply = () => null;
    mockIPC((cmd, args) => {
      calls.push({ cmd, args });
      return reply(cmd);
    });
    files = TestBed.inject(EditorFiles);
  });

  afterEach(() => clearMocks());

  it('reads a text file of a connection', async () => {
    const file = {
      text: 'a\n',
      size: 2,
      writable: true,
      version: 'v1',
      lineEnding: 'lf',
      bom: false,
      target: null,
    };
    reply = () => file;
    expect(await files.read('h1', '/etc/hosts')).toEqual(file);
    expect(calls).toEqual([
      { cmd: 'sftp_read_text', args: { connectionId: 'h1', path: '/etc/hosts' } },
    ]);
  });

  it('writes with the expected version, line ending and BOM', async () => {
    reply = () => ({ version: 'v2', size: 3 });
    const saved = await files.write('h1', '/a', {
      text: 'abc',
      expectedVersion: null,
      lineEnding: 'crlf',
      bom: true,
      expectedTarget: '/srv/real',
    });
    expect(saved).toEqual({ version: 'v2', size: 3 });
    expect(calls[0]).toEqual({
      cmd: 'sftp_write_text',
      args: {
        connectionId: 'h1',
        path: '/a',
        text: 'abc',
        expectedVersion: null,
        lineEnding: 'crlf',
        bom: true,
        expectedTarget: '/srv/real',
      },
    });
  });

  it('maps backend errors, not_text included', async () => {
    mockIPC(() => Promise.reject({ code: 'not_text', message: 'not UTF-8 text' }));
    await expect(files.read('h1', '/bin/ls')).rejects.toEqual(
      new IpcError('not_text', 'not UTF-8 text'),
    );
  });
});
