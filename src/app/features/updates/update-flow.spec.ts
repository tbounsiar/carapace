import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { TranslocoService } from '@jsverse/transloco';
import { type TuiNotificationOptions, TuiNotificationService } from '@taiga-ui/core';
import { Observable, of } from 'rxjs';
import { ConfigService } from '../../core/ipc/config';
import { host } from '../../core/ipc/config.fixture';
import { type EditedFile, ExternalEditsIpc } from '../../core/ipc/external-edits';
import { editedFile } from '../../core/ipc/external-edits.fixture';
import { IpcError } from '../../core/ipc/ipc-error';
import { SshService } from '../../core/ipc/ssh';
import type { TransferView } from '../../core/ipc/transfers';
import {
  type UpdateEvent,
  type UpdateInfo,
  type UpdateProgress,
  type UpdateState,
  UpdatesIpc,
} from '../../core/ipc/updates';
import { OpenDialogs } from '../../shared/open-dialogs';
import { TransferQueue } from '../transfers/transfer-queue';
import { Workspace } from '../workspace/workspace';
import type { UpdateErrorData } from './update-error/update-error';
import { UpdateFlow } from './update-flow';
import { UpdateStore } from './update-store';

@Component({ template: '' })
class Blank {}

const INFO: UpdateInfo = { version: '0.3.0', date: null };

function updateState(patch: Partial<UpdateState> = {}): UpdateState {
  return {
    current: '0.2.0',
    autoCheck: true,
    skippedVersion: null,
    lastCheck: null,
    available: null,
    downloaded: false,
    installKind: 'inPlace',
    ...patch,
  };
}

interface Opened {
  readonly content: unknown;
  readonly options: Partial<TuiNotificationOptions<UpdateErrorData | undefined>>;
  closed: boolean;
}

describe('UpdateFlow', () => {
  let state: UpdateState;
  let emit: (event: UpdateEvent) => void;
  let onProgress: (progress: UpdateProgress) => void;
  let finishDownload: (err?: unknown) => void;
  let opened: Opened[];
  let answers: boolean[];
  let edited: EditedFile[];
  const order: string[] = [];
  const ipc = {
    state: vi.fn(() => Promise.resolve(state)),
    setAutoCheck: vi.fn((enabled: boolean) => {
      state = { ...state, autoCheck: enabled };
      return Promise.resolve(state);
    }),
    check: vi.fn((): Promise<UpdateInfo | null> => Promise.resolve(INFO)),
    subscribe: vi.fn((onEvent: (event: UpdateEvent) => void) => {
      emit = onEvent;
      return Promise.resolve();
    }),
    skip: vi.fn((version: string) => {
      state = { ...state, skippedVersion: version };
      return Promise.resolve(state);
    }),
    download: vi.fn(
      (progress: (p: UpdateProgress) => void) =>
        new Promise<void>((resolve, reject) => {
          onProgress = progress;
          finishDownload = (err?: unknown) => (err ? reject(err) : resolve());
        }),
    ),
    cancelDownload: vi.fn(() => {
      finishDownload(new IpcError('cancelled', 'the download was cancelled'));
      return Promise.resolve();
    }),
    apply: vi.fn((confirmed: boolean) => {
      order.push(`apply:${confirmed}`);
      return Promise.resolve();
    }),
    openReleaseNotes: vi.fn(() => Promise.resolve()),
  };
  const alerts = {
    open: vi.fn((content: unknown, options: Opened['options']) => {
      const entry: Opened = { content, options, closed: false };
      opened.push(entry);
      return new Observable<never>(() => () => (entry.closed = true));
    }),
  };
  const none = signal(true);
  const dialogs = { none, open: vi.fn(() => of(answers.shift())) };
  const external = {
    list: vi.fn(() => Promise.resolve(edited)),
    stopAll: vi.fn(() => {
      order.push('stopAll');
      return Promise.resolve(1);
    }),
  };
  const sshStates = signal<Record<string, string>>({});
  const transfers = signal<Partial<TransferView>[]>([]);
  const settle = async (n = 3) => {
    for (let i = 0; i < n; i++) {
      await new Promise((r) => setTimeout(r));
    }
  };
  const infoNotices = () => opened.filter((o) => o.options.appearance === 'info');
  const errorNotices = () => opened.filter((o) => o.options.appearance === 'negative');
  let flow: UpdateFlow;
  let store: UpdateStore;

  beforeAll(async () => {
    await import('./update-notice/update-notice');
    await import('./update-error/update-error');
    await import('../../shared/destructive-confirm/destructive-confirm');
  }, 60_000);

  beforeEach(async () => {
    vi.clearAllMocks();
    state = updateState();
    opened = [];
    answers = [];
    edited = [];
    order.length = 0;
    none.set(true);
    sshStates.set({});
    transfers.set([]);
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: '**', component: Blank }]),
        { provide: UpdatesIpc, useValue: ipc },
        { provide: TuiNotificationService, useValue: alerts },
        { provide: OpenDialogs, useValue: dialogs },
        { provide: ExternalEditsIpc, useValue: external },
        { provide: SshService, useValue: { states: sshStates } },
        { provide: TransferQueue, useValue: { transfers } },
        {
          provide: ConfigService,
          useValue: {
            loaded: signal(true),
            findHost: () => ({ project: null, host: host('h1', 'vps') }),
          },
        },
      ],
    });
    TestBed.inject(TranslocoService);
    flow = TestBed.inject(UpdateFlow);
    store = TestBed.inject(UpdateStore);
    await flow.start();
  });

  /** An automatic check found 0.3.0 and the user pressed Update. */
  async function downloadAndFinish(err?: unknown): Promise<void> {
    emit({ kind: 'available', info: INFO });
    await settle();
    const updating = flow.update();
    await settle(1);
    finishDownload(err);
    await updating;
    await settle();
  }

  describe('automatic offers', () => {
    it('shows the notice at the bottom end, without a close button, and the badge', async () => {
      expect(ipc.subscribe).toHaveBeenCalledOnce();
      emit({ kind: 'available', info: INFO });
      await settle();
      expect(store.offer()).toEqual(INFO);
      expect(store.phase()).toBe('available');
      expect(store.badge()).toBe(true);
      expect(infoNotices()).toHaveLength(1);
      expect(infoNotices()[0].options).toEqual(
        expect.objectContaining({ autoClose: 0, closable: false, block: 'end' }),
      );
    });

    it('waits for no open dialog before showing the notice', async () => {
      none.set(false);
      emit({ kind: 'available', info: INFO });
      await settle();
      expect(infoNotices()).toHaveLength(0);
      none.set(true);
      TestBed.tick();
      await settle();
      expect(infoNotices()).toHaveLength(1);
    });

    it('Later closes the notice for this run and keeps the badge', async () => {
      emit({ kind: 'available', info: INFO });
      await settle();
      flow.later();
      expect(infoNotices()[0].closed).toBe(true);
      expect(store.badge()).toBe(true);
      emit({ kind: 'available', info: INFO });
      await settle();
      expect(infoNotices()).toHaveLength(1);
      emit({ kind: 'available', info: { version: '0.3.1', date: null } });
      await settle();
      expect(infoNotices()).toHaveLength(2);
    });

    it('Skip stores the version, closes the notice and hides the badge', async () => {
      emit({ kind: 'available', info: INFO });
      await settle();
      await flow.skip();
      expect(ipc.skip).toHaveBeenCalledWith('0.3.0');
      expect(infoNotices()[0].closed).toBe(true);
      expect(store.skipped()).toBe(true);
      expect(store.badge()).toBe(false);
      emit({ kind: 'available', info: INFO });
      await settle();
      expect(infoNotices()).toHaveLength(1);
    });

    it('a failed skip toasts "Setting not saved"', async () => {
      emit({ kind: 'available', info: INFO });
      await settle();
      ipc.skip.mockRejectedValueOnce(new IpcError('io', 'disk full'));
      await flow.skip();
      expect(alerts.open).toHaveBeenLastCalledWith(
        expect.any(String),
        expect.objectContaining({ label: 'Setting not saved', appearance: 'negative' }),
      );
      expect(infoNotices()[0].closed).toBe(false);
    });

    it('shows a skipped version in Settings only (offer, no badge, no notice)', async () => {
      TestBed.resetTestingModule();
      state = updateState({ skippedVersion: '0.3.0', available: INFO });
      TestBed.configureTestingModule({
        providers: [
          { provide: UpdatesIpc, useValue: ipc },
          { provide: TuiNotificationService, useValue: alerts },
          { provide: OpenDialogs, useValue: dialogs },
          { provide: ConfigService, useValue: { loaded: signal(true) } },
          { provide: SshService, useValue: { states: sshStates } },
          { provide: TransferQueue, useValue: { transfers } },
        ],
      });
      const fresh = TestBed.inject(UpdateFlow);
      await fresh.start();
      const freshStore = TestBed.inject(UpdateStore);
      expect(freshStore.offer()).toEqual(INFO);
      expect(freshStore.skipped()).toBe(true);
      expect(freshStore.badge()).toBe(false);
      expect(opened).toHaveLength(0);
    });
  });

  describe('Check now', () => {
    it('up to date: status and last check from the backend', async () => {
      ipc.check.mockResolvedValueOnce(null);
      state = updateState({ lastCheck: '2026-11-20T13:03:00Z' });
      await flow.check();
      expect(store.check()).toBe('upToDate');
      expect(store.state()?.lastCheck).toBe('2026-11-20T13:03:00Z');
      expect(opened).toHaveLength(0);
    });

    it('a second click joins the running check', async () => {
      const first = flow.check();
      const second = flow.check();
      expect(store.check()).toBe('checking');
      await Promise.all([first, second]);
      expect(ipc.check).toHaveBeenCalledOnce();
    });

    it('shows the notice for a newer version, even skipped or dismissed', async () => {
      state = updateState({ skippedVersion: '0.3.0' });
      await flow.check();
      await settle();
      expect(store.offer()).toEqual(INFO);
      expect(store.check()).toBe('idle');
      expect(infoNotices()).toHaveLength(1);
      flow.later();
      await flow.check();
      await settle();
      expect(infoNotices()).toHaveLength(2);
    });

    it('a failure stays inline: no toast', async () => {
      ipc.check.mockRejectedValueOnce(new IpcError('network', 'could not reach the server'));
      await flow.check();
      expect(store.check()).toBe('idle');
      expect(store.failure()).toEqual(expect.objectContaining({ kind: 'check' }));
      expect(opened).toHaveLength(0);
    });

    it('not_found reads as up to date, unsupported marks the build', async () => {
      ipc.check.mockRejectedValueOnce(new IpcError('not_found', 'no update is available'));
      await flow.check();
      expect(store.check()).toBe('upToDate');
      ipc.check.mockRejectedValueOnce(new IpcError('unsupported', 'unsupported'));
      await flow.check();
      expect(store.unsupported()).toBe(true);
      expect(store.failure()).toBeNull();
    });
  });

  describe('automatic check switch', () => {
    it('saves and runs one silent check when turned on', async () => {
      state = updateState({ skippedVersion: '0.3.0' });
      expect(await flow.setAutoCheck(true)).toBe(true);
      await settle();
      expect(ipc.setAutoCheck).toHaveBeenCalledWith(true);
      expect(ipc.check).toHaveBeenCalledOnce();
      // Treated as automatic: a skipped version is not announced.
      expect(opened).toHaveLength(0);
    });

    it('turning it off checks nothing; a failed save toasts and reports false', async () => {
      expect(await flow.setAutoCheck(false)).toBe(true);
      expect(ipc.check).not.toHaveBeenCalled();
      ipc.setAutoCheck.mockRejectedValueOnce(new IpcError('io', 'disk full'));
      expect(await flow.setAutoCheck(true)).toBe(false);
      expect(alerts.open).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ label: 'Setting not saved' }),
      );
    });
  });

  describe('download', () => {
    it('shows progress, then verifying, then installs at once when nothing is open', async () => {
      emit({ kind: 'available', info: INFO });
      await settle();
      const updating = flow.update();
      await settle(1);
      expect(store.phase()).toBe('downloading');
      onProgress({ downloaded: 100, total: 200 });
      expect(store.progress()).toEqual({ downloaded: 100, total: 200 });
      onProgress({ downloaded: 200, total: 200 });
      expect(store.phase()).toBe('verifying');
      finishDownload();
      await updating;
      expect(ipc.apply).toHaveBeenCalledWith(true);
      expect(store.phase()).toBe('installing');
      expect(dialogs.open).not.toHaveBeenCalled();
    });

    it('throttles progress to one repaint per interval', async () => {
      emit({ kind: 'available', info: INFO });
      await settle();
      void flow.update();
      await settle(1);
      onProgress({ downloaded: 1, total: null });
      onProgress({ downloaded: 2, total: null });
      expect(store.progress()).toEqual({ downloaded: 1, total: null });
    });

    it('Cancel goes back to Available, closes the notice and keeps the badge', async () => {
      emit({ kind: 'available', info: INFO });
      await settle();
      const updating = flow.update();
      await settle(1);
      await flow.cancel();
      await updating;
      expect(store.phase()).toBe('available');
      expect(infoNotices()[0].closed).toBe(true);
      expect(errorNotices()).toHaveLength(0);
      expect(store.badge()).toBe(true);
    });

    it('a failure opens "Update not downloaded" with Retry', async () => {
      await downloadAndFinish(new IpcError('network', 'could not reach the update server'));
      expect(store.phase()).toBe('available');
      expect(store.failure()?.kind).toBe('download');
      expect(infoNotices()[0].closed).toBe(true);
      const [error] = errorNotices();
      expect(error.options).toEqual(
        expect.objectContaining({
          label: 'Update not downloaded',
          closable: true,
          autoClose: 0,
          block: 'end',
        }),
      );
      const data = error.options.data!;
      expect(data.action).toBe('retry');
      expect(data.text).toBe(
        'Could not reach the update server. Check your internet connection and try again.',
      );
      data.run();
      await settle(1);
      expect(error.closed).toBe(true);
      expect(ipc.download).toHaveBeenCalledTimes(2);
    });

    it('a signature refusal has no Retry and is not offered again automatically', async () => {
      await downloadAndFinish(
        new IpcError('signature_invalid', 'the update signature was refused'),
      );
      const [error] = errorNotices();
      expect(error.options).toEqual(
        expect.objectContaining({ label: 'Update refused', icon: '@tui.shield-x' }),
      );
      expect(error.options.data!.action).toBeNull();
      expect(error.options.data!.text).toContain('not signed with Carapace');
      expect(store.offer()).toBeNull();
      expect(store.badge()).toBe(false);
      emit({ kind: 'available', info: INFO });
      await settle();
      expect(store.offer()).toBeNull();
      expect(infoNotices()).toHaveLength(1);
      await flow.check();
      await settle();
      expect(store.offer()).toEqual(INFO);
      expect(infoNotices()).toHaveLength(2);
    });

    it('download-only: Download opens the release page and counts as Later', async () => {
      state = updateState({ installKind: 'downloadOnly' });
      await flow.check();
      await settle();
      await flow.update();
      expect(ipc.openReleaseNotes).toHaveBeenCalledWith('0.3.0');
      expect(ipc.download).not.toHaveBeenCalled();
      expect(infoNotices()[0].closed).toBe(true);
      expect(store.badge()).toBe(true);
    });
  });

  describe('restart decision', () => {
    it('only connections or transfers open: Ready, then Restart now installs', async () => {
      sshStates.set({ h1: 'connected', h2: 'connected', h3: 'idle' });
      transfers.set([{ state: 'running' }, { state: 'done' }]);
      await downloadAndFinish();
      expect(ipc.apply).not.toHaveBeenCalled();
      expect(store.phase()).toBe('ready');
      expect(store.badge()).toBe(true);
      expect(flow.impact()).toEqual({ connections: 2, transfers: 1, dialog: false });
      await flow.restartNow();
      expect(ipc.apply).toHaveBeenCalledWith(true);
    });

    it('an open dialog also pauses at Ready', async () => {
      emit({ kind: 'available', info: INFO });
      await settle();
      const updating = flow.update();
      await settle(1);
      none.set(false);
      finishDownload();
      await updating;
      expect(store.phase()).toBe('ready');
      expect(flow.impact().dialog).toBe(true);
      // Closing the dialog empties the impact but never installs on its own.
      none.set(true);
      TestBed.tick();
      await settle();
      expect(flow.impact()).toEqual({ connections: 0, transfers: 0, dialog: false });
      expect(store.phase()).toBe('ready');
      expect(ipc.apply).not.toHaveBeenCalled();
      await flow.restartNow();
      expect(ipc.apply).toHaveBeenCalledWith(true);
    });

    it('unsaved changes go through the quit confirm with the connection and transfer lines', async () => {
      sshStates.set({ h1: 'connected' });
      transfers.set([{ state: 'queued' }]);
      edited = [editedFile('e1', 'h1', '/srv/app.env', { notUploaded: true })];
      answers = [true];
      await downloadAndFinish();
      expect(dialogs.open).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          label: 'Quit with unsaved changes?',
          data: expect.objectContaining({
            lines: [
              'Not uploaded from your editor: app.env (vps)',
              '1 open connection and its terminals will be closed.',
              '1 transfer in progress will stop.',
            ],
          }),
        }),
      );
      expect(order).toEqual(['stopAll', 'apply:true']);
      expect(external.stopAll).toHaveBeenCalledWith(true);
    });

    it('Cancel at the confirm leaves the update Ready and shows the first modified editor', async () => {
      const tab = TestBed.inject(Workspace).add({
        key: 'edit:h1:/a',
        kind: 'edit',
        hostId: 'h1',
        label: 'nginx.conf',
        status: signal({ kind: 'connected' as const, word: 'Connected' }),
        modified: signal(true),
      });
      answers = [false];
      await downloadAndFinish();
      expect(ipc.apply).not.toHaveBeenCalled();
      expect(external.stopAll).not.toHaveBeenCalled();
      expect(store.phase()).toBe('ready');
      expect(TestBed.inject(Router).url).toBe(`/tabs/${tab.id}`);
    });

    it('does not stop editing when no file is pending', async () => {
      TestBed.inject(Workspace).add({
        key: 'edit:h1:/a',
        kind: 'edit',
        hostId: 'h1',
        label: 'nginx.conf',
        status: signal({ kind: 'connected' as const, word: 'Connected' }),
        modified: signal(true),
      });
      answers = [true];
      await downloadAndFinish();
      expect(order).toEqual(['apply:true']);
    });
  });

  describe('install errors', () => {
    it('install_failed: "Update not installed", keeps working, release page', async () => {
      ipc.apply.mockRejectedValueOnce(
        new IpcError('install_failed', 'the update could not be installed'),
      );
      await downloadAndFinish();
      expect(store.phase()).toBe('ready');
      const [error] = errorNotices();
      expect(error.options.label).toBe('Update not installed');
      expect(error.options.data!.text).toContain('Restart Carapace');
      expect(error.options.data!.text).toContain('Your current version keeps working.');
      expect(error.options.data!.action).toBe('releasePage');
      error.options.data!.run();
      await settle(1);
      expect(ipc.openReleaseNotes).toHaveBeenCalledWith('0.3.0');
    });

    it('restart_required: no action button', async () => {
      ipc.apply.mockRejectedValueOnce(
        new IpcError('restart_required', 'restart Carapace to finish', {}),
      );
      await downloadAndFinish();
      const [error] = errorNotices();
      expect(error.options.data!.action).toBeNull();
      expect(error.options.data!.text).not.toContain('keeps working');
    });

    it('a signature refusal at install is a refusal', async () => {
      ipc.apply.mockRejectedValueOnce(new IpcError('signature_invalid', 'refused'));
      await downloadAndFinish();
      expect(store.offer()).toBeNull();
      expect(errorNotices()[0].options.label).toBe('Update refused');
    });

    it('not_uploaded goes back to Ready with the error', async () => {
      ipc.apply.mockRejectedValueOnce(new IpcError('not_uploaded', 'some files are not uploaded'));
      await downloadAndFinish();
      expect(store.phase()).toBe('ready');
      expect(store.failure()?.kind).toBe('install');
    });
  });
});
