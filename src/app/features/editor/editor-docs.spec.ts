import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { TuiDialogService, TuiNotificationService } from '@taiga-ui/core';
import { of } from 'rxjs';
import { ConfigService } from '../../core/ipc/config';
import { host } from '../../core/ipc/config.fixture';
import { EditorFiles, type TextFile } from '../../core/ipc/editor-files';
import { IpcError } from '../../core/ipc/ipc-error';
import { SshService } from '../../core/ipc/ssh';
import type { ConnectionState, EndReason } from '../../core/ipc/ssh.models';
import { HostConnector } from '../host-connection/host-connector';
import { tabKey, Workspace } from '../workspace/workspace';
import { type EditorDoc, EditorDocs } from './editor-docs';
import { EditorFactory } from './editor-factory';
import { FakeEditorFactory } from './fake-editor';

@Component({ template: '' })
class Blank {}

const VPS = host('h1', 'vps');
const FILE: TextFile = {
  text: 'user www-data;\n',
  size: 15,
  writable: true,
  version: 'v1',
  lineEnding: 'lf',
  bom: false,
  target: null,
};

describe('EditorDocs', () => {
  let docs: EditorDocs;
  let workspace: Workspace;
  let factory: FakeEditorFactory;
  const states = signal<Record<string, ConnectionState>>({});
  const endReasons = signal<Record<string, EndReason>>({});
  const files = {
    read: vi.fn((): Promise<TextFile> => Promise.resolve(FILE)),
    write: vi.fn(() => Promise.resolve({ version: 'v2', size: 16 })),
  };
  const connector = {
    connect: vi.fn(() => {
      states.update((s) => ({ ...s, h1: 'connected' }));
      return Promise.resolve();
    }),
  };
  const alerts = { open: vi.fn(() => of(undefined)) };
  let answers: unknown[];
  const dialogs = { open: vi.fn(() => of(answers.shift())) };

  beforeEach(async () => {
    vi.clearAllMocks();
    states.set({ h1: 'connected' });
    endReasons.set({});
    answers = [];
    factory = new FakeEditorFactory();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: '**', component: Blank }]),
        { provide: EditorFiles, useValue: files },
        { provide: EditorFactory, useValue: factory },
        {
          provide: SshService,
          useValue: { states, endReasons, stateOf: (id: string) => states()[id] ?? 'idle' },
        },
        { provide: HostConnector, useValue: connector },
        { provide: TuiNotificationService, useValue: alerts },
        { provide: TuiDialogService, useValue: dialogs },
        {
          provide: ConfigService,
          useValue: {
            findHost: (id: string) => (id === 'h1' ? { project: null, host: VPS } : null),
          },
        },
      ],
    });
    docs = TestBed.inject(EditorDocs);
    workspace = TestBed.inject(Workspace);
    await import('./editor-choice-dialog/editor-choice-dialog');
    await import('../../shared/destructive-confirm/destructive-confirm');
  });

  async function open(
    path = '/etc/nginx/nginx.conf',
    size: number | null = 15,
  ): Promise<EditorDoc> {
    await docs.open(VPS, path, size);
    await new Promise((r) => setTimeout(r));
    return workspace.byKey(tabKey('edit', 'h1', path))!.doc!;
  }

  it('opens a file in a routed editor tab with its language', async () => {
    const doc = await open();
    const tab = workspace.byKey('edit:h1:/etc/nginx/nginx.conf')!;
    expect(tab).toMatchObject({ kind: 'edit', label: 'nginx.conf', path: '/etc/nginx/nginx.conf' });
    expect(TestBed.inject(Router).url).toBe(`/tabs/${tab.id}`);
    expect(files.read).toHaveBeenCalledWith('h1', '/etc/nginx/nginx.conf');
    expect(doc.phase()).toBe('ready');
    expect(doc.language()).toBe('nginx');
    expect(factory.created[0].options.label).toBe('Contents of nginx.conf');
    expect(tab.status().kind).toBe('connected');
  });

  it('focuses an open file instead of reading it again', async () => {
    await open();
    await open();
    expect(files.read).toHaveBeenCalledTimes(1);
    expect(workspace.tabs()).toHaveLength(1);
  });

  it('refuses files over 5 MiB from the listing size without a tab', async () => {
    await docs.open(VPS, '/var/big.log', 6 * 1024 * 1024);
    expect(workspace.tabs()).toEqual([]);
    expect(alerts.open).toHaveBeenCalledWith(
      'big.log is too large to edit here (6.0 MiB, max 5 MiB). Download it instead.',
      expect.objectContaining({ label: 'File not opened' }),
    );
  });

  it.each([
    [
      new IpcError('not_text', 'x is not a text file'),
      'ls isn’t UTF-8 text. Only text files can be edited here.',
    ],
    [new IpcError('permission_denied', 'denied'), 'You don’t have permission to read ls on vps.'],
  ])('removes the tab and explains a failed read', async (err, message) => {
    files.read.mockRejectedValueOnce(err);
    await docs.open(VPS, '/bin/ls', 10);
    expect(workspace.tabs()).toEqual([]);
    expect(alerts.open).toHaveBeenCalledWith(
      message,
      expect.objectContaining({ label: 'File not opened' }),
    );
  });

  it('removes the tab when the editor chunk fails to load', async () => {
    factory.fail = true;
    await docs.open(VPS, '/a.txt', 1);
    expect(workspace.tabs()).toEqual([]);
    expect(alerts.open).toHaveBeenCalledWith(
      'The editor could not be loaded. Try again.',
      expect.anything(),
    );
  });

  it('opens large files as plain text and read-only files read-only', async () => {
    files.read.mockResolvedValueOnce({ ...FILE, size: 2 * 1024 * 1024, writable: false });
    const doc = await open('/etc/app.conf', null);
    expect(doc.language()).toBe('plain');
    expect(doc.large()).toBe(true);
    expect(doc.readOnly()).toBe(true);
    expect(factory.created[0].readOnly).toBe(true);
    expect(await doc.save()).toBe(false);
    expect(files.write).not.toHaveBeenCalled();
  });

  it('saves with the version, line ending and BOM, and tracks the modified state', async () => {
    files.read.mockResolvedValueOnce({ ...FILE, lineEnding: 'crlf', bom: true });
    const doc = await open();
    const editor = factory.created[0];
    expect(doc.modified()).toBe(false);
    expect(await doc.save()).toBe(true);
    expect(files.write).not.toHaveBeenCalled();
    editor.type('user nginx;\n');
    expect(doc.modified()).toBe(true);
    expect(workspace.tabs()[0].modified()).toBe(true);
    expect(await doc.save()).toBe(true);
    expect(files.write).toHaveBeenCalledWith('h1', '/etc/nginx/nginx.conf', {
      text: 'user nginx;\n',
      expectedVersion: 'v1',
      lineEnding: 'crlf',
      bom: true,
      expectedTarget: null,
    });
    expect(doc.modified()).toBe(false);
    expect(doc.savedAt()).toBeInstanceOf(Date);
    editor.type('again\n');
    await doc.save();
    expect(files.write).toHaveBeenLastCalledWith(
      'h1',
      '/etc/nginx/nginx.conf',
      expect.objectContaining({ expectedVersion: 'v2' }),
    );
  });

  it('saves a mixed file with LF', async () => {
    files.read.mockResolvedValueOnce({ ...FILE, lineEnding: 'mixed' });
    const doc = await open();
    expect(doc.lineEnding()).toBe('lf');
    expect(doc.mixedEndings()).toBe(true);
  });

  it('keeps text typed during a save modified', async () => {
    const doc = await open();
    const editor = factory.created[0];
    editor.type('a\n');
    let finish: (v: { version: string; size: number }) => void = () => undefined;
    files.write.mockReturnValueOnce(new Promise((r) => (finish = r)));
    const saving = doc.save();
    await Promise.resolve();
    expect(doc.phase()).toBe('saving');
    expect(workspace.tabs()[0].status().word).toBe('Saving…');
    editor.type('a\nb\n');
    finish({ version: 'v2', size: 2 });
    expect(await saving).toBe(true);
    expect(doc.modified()).toBe(true);
  });

  it('connects first when disconnected, and keeps the buffer if that is cancelled', async () => {
    const doc = await open();
    factory.created[0].type('x');
    states.set({});
    connector.connect.mockImplementationOnce(() => Promise.resolve());
    expect(doc.banner()).toBe('ended');
    expect(await doc.save()).toBe(false);
    expect(files.write).not.toHaveBeenCalled();
    expect(doc.modified()).toBe(true);
    endReasons.set({ h1: 'lost' });
    expect(doc.banner()).toBe('lost');
    await doc.reconnect();
    expect(doc.banner()).toBeNull();
    expect(await doc.save()).toBe(true);
  });

  it('overwrites after a conflict when asked', async () => {
    const doc = await open();
    factory.created[0].type('x');
    files.write.mockRejectedValueOnce(
      new IpcError('conflict', '/etc/nginx/nginx.conf changed on the server since it was opened', {
        key: 'errors.files.changed',
        params: { path: '/etc/nginx/nginx.conf' },
      }),
    );
    answers = ['overwrite'];
    expect(await doc.save()).toBe(true);
    expect(files.write).toHaveBeenLastCalledWith(
      'h1',
      '/etc/nginx/nginx.conf',
      expect.objectContaining({ expectedVersion: null }),
    );
    expect(dialogs.open).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ data: { kind: 'changed', name: 'nginx.conf', host: 'vps' } }),
    );
  });

  it('reloads from the server after a conflict, or keeps both on cancel', async () => {
    const doc = await open();
    const editor = factory.created[0];
    editor.type('mine');
    files.write.mockRejectedValue(
      new IpcError('conflict', '/etc/nginx/nginx.conf no longer exists on the server', {
        key: 'errors.files.deleted',
        params: { path: '/etc/nginx/nginx.conf' },
      }),
    );
    answers = ['cancel'];
    expect(await doc.save()).toBe(false);
    expect(dialogs.open).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ data: expect.objectContaining({ kind: 'deleted' }) }),
    );
    expect(editor.text).toBe('mine');
    answers = ['reload'];
    files.read.mockResolvedValueOnce({ ...FILE, text: 'theirs\n', version: 'v9' });
    expect(await doc.save()).toBe(false);
    expect(editor.text).toBe('theirs\n');
    expect(doc.modified()).toBe(false);
    files.write.mockReset();
  });

  it('sends the link target and shows a retargeted link as its own conflict', async () => {
    files.read.mockResolvedValueOnce({ ...FILE, target: '/srv/real.conf' });
    const doc = await open();
    factory.created[0].type('x');
    files.write.mockRejectedValueOnce(
      new IpcError('conflict', '/etc/nginx/nginx.conf now points to another file on the server', {
        key: 'errors.files.retargeted',
        params: { path: '/etc/nginx/nginx.conf' },
      }),
    );
    answers = ['cancel'];
    expect(await doc.save()).toBe(false);
    expect(files.write).toHaveBeenCalledWith(
      'h1',
      '/etc/nginx/nginx.conf',
      expect.objectContaining({ expectedTarget: '/srv/real.conf' }),
    );
    expect(dialogs.open).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ data: expect.objectContaining({ kind: 'retargeted' }) }),
    );
  });

  it('shows save errors in a banner and keeps the buffer modified', async () => {
    const doc = await open();
    factory.created[0].type('x');
    files.write.mockRejectedValueOnce(
      new IpcError('partial_write', 'nginx.conf may be incomplete'),
    );
    expect(await doc.save()).toBe(false);
    expect(doc.error()).toContain('Not saved: Nginx.conf may be incomplete.');
    expect(doc.partial()).toBe(true);
    expect(doc.modified()).toBe(true);
    expect(await doc.save()).toBe(true);
    expect(doc.error()).toBeNull();
    expect(doc.partial()).toBe(false);
  });

  it('reloads directly when clean and asks first when modified', async () => {
    const doc = await open();
    await doc.reload();
    expect(dialogs.open).not.toHaveBeenCalled();
    expect(files.read).toHaveBeenCalledTimes(2);
    doc.setLanguage('yaml');
    factory.created[0].type('x');
    answers = [false];
    await doc.reload();
    expect(files.read).toHaveBeenCalledTimes(2);
    answers = [true];
    await doc.reload();
    expect(files.read).toHaveBeenCalledTimes(3);
    expect(doc.modified()).toBe(false);
    expect(doc.language()).toBe('yaml');
  });

  it('shows a link target and toggles wrap', async () => {
    files.read.mockResolvedValueOnce({ ...FILE, target: '/srv/real.conf' });
    const doc = await open();
    expect(doc.target()).toBe('/srv/real.conf');
    doc.toggleWrap();
    expect(factory.created[0].wrap).toBe(true);
    factory.created[0].options.onToggleWrap();
    expect(doc.wrap()).toBe(false);
  });

  it('destroys the editor with its tab', async () => {
    await open();
    workspace.drop([workspace.tabs()[0].id]);
    expect(factory.created[0].destroyed).toBe(true);
  });
});
