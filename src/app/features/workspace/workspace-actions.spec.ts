import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { TuiDialogService } from '@taiga-ui/core';
import { of } from 'rxjs';
import { ConfigService } from '../../core/ipc/config';
import { host } from '../../core/ipc/config.fixture';
import { SshService } from '../../core/ipc/ssh';
import type { EditorDoc } from '../editor/editor-docs';
import { HostConnector } from '../host-connection/host-connector';
import { HostLauncher } from '../host-connection/host-launcher';
import type { TabStatus } from './tab-status';
import { Workspace, type WorkspaceTab } from './workspace';
import { WorkspaceActions } from './workspace-actions';

@Component({ template: '' })
class Blank {}

const UP: TabStatus = { kind: 'connected', word: 'Connected' };

describe('WorkspaceActions', () => {
  let actions: WorkspaceActions;
  let workspace: Workspace;
  let router: Router;
  let answers: unknown[];
  const dialogs = { open: vi.fn(() => of(answers.shift())) };
  const launcher = { newTerminal: vi.fn(), openFiles: vi.fn(), open: vi.fn() };
  const connector = { connect: vi.fn(), disconnect: vi.fn() };
  const state = signal<'connected' | 'idle'>('connected');
  const hosts = [host('h1', 'vps'), host('h2', 'db')];

  function editor(hostId: string, name: string, modified: boolean, saves = true): WorkspaceTab {
    const doc = { save: vi.fn(() => Promise.resolve(saves)) } as unknown as EditorDoc;
    return workspace.add({
      key: `edit:${hostId}:/${name}`,
      kind: 'edit',
      hostId,
      label: name,
      path: `/${name}`,
      status: signal(UP),
      modified: signal(modified),
      doc,
    });
  }

  function terminal(hostId: string, dispose = vi.fn()): WorkspaceTab {
    return workspace.add({
      key: `terminal:${hostId}:${Math.random()}`,
      kind: 'terminal',
      hostId,
      label: 'Terminal 1',
      status: signal(UP),
      dispose,
    });
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    answers = [];
    state.set('connected');
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: '**', component: Blank }]),
        { provide: TuiDialogService, useValue: dialogs },
        { provide: HostLauncher, useValue: launcher },
        { provide: HostConnector, useValue: connector },
        { provide: SshService, useValue: { stateOf: () => state() } },
        {
          provide: ConfigService,
          useValue: {
            findHost: (id: string) => {
              const h = hosts.find((x) => x.id === id);
              return h ? { project: null, host: h } : null;
            },
          },
        },
      ],
    });
    actions = TestBed.inject(WorkspaceActions);
    workspace = TestBed.inject(Workspace);
    router = TestBed.inject(Router);
    await import('../editor/editor-choice-dialog/editor-choice-dialog');
    await import('../../shared/destructive-confirm/destructive-confirm');
  });

  it('closes a terminal without asking and releases it', async () => {
    const dispose = vi.fn();
    const tab = terminal('h1', dispose);
    expect(await actions.close(tab)).toBe(true);
    expect(dialogs.open).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalled();
    expect(workspace.tabs()).toEqual([]);
  });

  it('asks before closing a modified editor: cancel, save, don’t save', async () => {
    const tab = editor('h1', 'nginx.conf', true);
    answers = ['cancel'];
    expect(await actions.close(tab)).toBe(false);
    expect(dialogs.open).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ label: 'Save changes to nginx.conf?' }),
    );
    answers = ['save'];
    expect(await actions.close(tab)).toBe(true);
    expect(tab.doc!.save).toHaveBeenCalled();
    expect(workspace.tabs()).toEqual([]);

    const other = editor('h1', 'b.conf', true);
    answers = ['discard'];
    expect(await actions.close(other)).toBe(true);
    expect(other.doc!.save).not.toHaveBeenCalled();
  });

  it('keeps a modified editor whose save fails', async () => {
    const tab = editor('h1', 'a.conf', true, false);
    answers = ['save'];
    expect(await actions.close(tab)).toBe(false);
    expect(workspace.tabs()).toEqual([tab]);
  });

  it('closes the other tabs with one question for the modified editors', async () => {
    const keep = terminal('h1');
    editor('h1', 'nginx.conf', true);
    editor('h2', 'app.env', true);
    terminal('h2');
    answers = [false];
    expect(await actions.closeOthers(keep)).toBe(false);
    expect(workspace.tabs()).toHaveLength(4);
    expect(dialogs.open).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        label: 'Close tabs with unsaved changes?',
        data: expect.objectContaining({
          content: 'Unsaved changes in nginx.conf (vps), app.env (db).',
          yes: 'Close without saving',
        }),
      }),
    );
    answers = [true];
    expect(await actions.closeOthers(keep)).toBe(true);
    expect(workspace.tabs()).toEqual([keep]);
  });

  it('closes the tabs of a host and routes away from the active one', async () => {
    const a = terminal('h1');
    const b = terminal('h2');
    await workspace.activate(a);
    expect(await actions.closeHost('h1')).toBe(true);
    expect(workspace.tabs()).toEqual([b]);
    expect(router.url).toBe(`/tabs/${b.id}`);
    await actions.closeHost('h2');
    expect(router.url).toBe('/hosts/h2');
  });

  it('builds the tab menu for the host', async () => {
    const tab = terminal('h1');
    const ids = () => actions.menu(tab).map((e) => e.id);
    expect(ids()).toEqual([
      'tab-menu-new-terminal',
      'tab-menu-files',
      'tab-menu-close',
      'tab-menu-close-others',
      'tab-menu-close-host',
      'tab-menu-disconnect',
      'tab-menu-host',
    ]);
    expect(actions.menu(tab).find((e) => e.id === 'tab-menu-close-host')?.label).toBe(
      'Close tabs of vps',
    );
    state.set('idle');
    expect(ids()).toContain('tab-menu-connect');
    actions.menu(tab)[0].run();
    expect(launcher.newTerminal).toHaveBeenCalledWith(hosts[0]);
    actions
      .menu(tab)
      .find((e) => e.id === 'tab-menu-connect')!
      .run();
    expect(connector.connect).toHaveBeenCalledWith(expect.objectContaining({ hostId: 'h1' }));
  });
});
