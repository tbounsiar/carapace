import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { TuiDialogService } from '@taiga-ui/core';
import { of } from 'rxjs';
import { type AppEvent, AppEvents } from '../../core/ipc/app-events';
import { ConfigService } from '../../core/ipc/config';
import { host } from '../../core/ipc/config.fixture';
import { type EditedFile, ExternalEditsIpc } from '../../core/ipc/external-edits';
import { editedFile } from '../../core/ipc/external-edits.fixture';
import { QuitGuard } from './quit-guard';
import { Workspace } from './workspace';

@Component({ template: '' })
class Blank {}

describe('QuitGuard', () => {
  let emit: (event: AppEvent) => void;
  let answers: unknown[];
  const events = {
    setQuitGuard: vi.fn(() => Promise.resolve()),
    subscribe: vi.fn((onEvent: (event: AppEvent) => void) => {
      emit = onEvent;
      return Promise.resolve();
    }),
    quit: vi.fn(() => Promise.resolve()),
  };
  const dialogs = { open: vi.fn(() => of(answers.shift())) };
  let edited: EditedFile[];
  const external = {
    list: vi.fn(() => Promise.resolve(edited)),
    stopAll: vi.fn(() => Promise.resolve(1)),
  };
  const settle = () => new Promise((r) => setTimeout(r));

  beforeEach(async () => {
    vi.clearAllMocks();
    answers = [];
    edited = [];
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: '**', component: Blank }]),
        { provide: AppEvents, useValue: events },
        { provide: TuiDialogService, useValue: dialogs },
        { provide: ExternalEditsIpc, useValue: external },
        {
          provide: ConfigService,
          useValue: { findHost: () => ({ project: null, host: host('h1', 'vps') }) },
        },
      ],
    });
    await import('../../shared/destructive-confirm/destructive-confirm');
  });

  it('sets the guard while an editor is modified and quits at once otherwise', async () => {
    const guard = TestBed.inject(QuitGuard);
    await guard.start();
    const modified = signal(false);
    TestBed.inject(Workspace).add({
      key: 'edit:h1:/a',
      kind: 'edit',
      hostId: 'h1',
      label: 'a',
      status: signal({ kind: 'connected' as const, word: 'Connected' }),
      modified,
    });
    TestBed.tick();
    expect(events.setQuitGuard).not.toHaveBeenCalled();
    modified.set(true);
    TestBed.tick();
    expect(events.setQuitGuard).toHaveBeenLastCalledWith(true);
    modified.set(false);
    TestBed.tick();
    expect(events.setQuitGuard).toHaveBeenLastCalledWith(false);
    emit({ kind: 'quitRequested' });
    await settle();
    expect(events.quit).toHaveBeenCalled();
    expect(dialogs.open).not.toHaveBeenCalled();
  });

  it('asks before quitting with unsaved changes; Cancel shows the first one', async () => {
    const guard = TestBed.inject(QuitGuard);
    await guard.start();
    const workspace = TestBed.inject(Workspace);
    const tab = workspace.add({
      key: 'edit:h1:/a',
      kind: 'edit',
      hostId: 'h1',
      label: 'nginx.conf',
      status: signal({ kind: 'connected' as const, word: 'Connected' }),
      modified: signal(true),
    });
    answers = [false];
    emit({ kind: 'quitRequested' });
    await settle();
    await settle();
    expect(dialogs.open).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        label: 'Quit with unsaved changes?',
        data: expect.objectContaining({
          content: 'Unsaved changes in nginx.conf (vps).',
          yes: 'Quit without saving',
        }),
      }),
    );
    expect(events.quit).not.toHaveBeenCalled();
    expect(events.setQuitGuard).toHaveBeenLastCalledWith(true);
    expect(TestBed.inject(Router).url).toBe(`/tabs/${tab.id}`);
    answers = [true];
    emit({ kind: 'quitRequested' });
    await settle();
    await settle();
    expect(events.quit).toHaveBeenCalled();
  });

  it('lists the edited files not uploaded; quitting stops them all first', async () => {
    const guard = TestBed.inject(QuitGuard);
    await guard.start();
    TestBed.inject(Workspace).add({
      key: 'edit:h1:/a',
      kind: 'edit',
      hostId: 'h1',
      label: 'nginx.conf',
      status: signal({ kind: 'connected' as const, word: 'Connected' }),
      modified: signal(true),
    });
    edited = [
      editedFile('e1', 'h1', '/srv/app.env', { state: 'waiting', notUploaded: true }),
      editedFile('e2', 'h1', '/srv/synced.txt'),
    ];
    answers = [true];
    emit({ kind: 'quitRequested' });
    await settle();
    await settle();
    expect(dialogs.open).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        data: expect.objectContaining({
          content: 'Unsaved changes in nginx.conf (vps). Not uploaded: app.env (vps).',
        }),
      }),
    );
    expect(external.stopAll).toHaveBeenCalledWith(true);
    expect(events.quit).toHaveBeenCalled();
    expect(external.stopAll.mock.invocationCallOrder[0]).toBeLessThan(
      events.quit.mock.invocationCallOrder[0],
    );
  });

  it('asks for not-uploaded files alone; Cancel opens the Edited files page', async () => {
    const guard = TestBed.inject(QuitGuard);
    await guard.start();
    edited = [editedFile('e1', 'h1', '/srv/app.env', { state: 'conflict', notUploaded: true })];
    answers = [false];
    emit({ kind: 'quitRequested' });
    await settle();
    await settle();
    expect(dialogs.open).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        data: expect.objectContaining({ content: 'Not uploaded: app.env (vps).' }),
      }),
    );
    expect(events.quit).not.toHaveBeenCalled();
    expect(external.stopAll).not.toHaveBeenCalled();
    expect(events.setQuitGuard).toHaveBeenLastCalledWith(false);
    expect(TestBed.inject(Router).url).toBe('/edited-files');
  });

  it('quits at once when every edited file is uploaded', async () => {
    const guard = TestBed.inject(QuitGuard);
    await guard.start();
    edited = [editedFile('e1', 'h1', '/srv/app.env')];
    emit({ kind: 'quitRequested' });
    await settle();
    expect(events.quit).toHaveBeenCalled();
    expect(dialogs.open).not.toHaveBeenCalled();
    expect(external.stopAll).not.toHaveBeenCalled();
  });
});
