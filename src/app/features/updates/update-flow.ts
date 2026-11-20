import { computed, DOCUMENT, inject, Injector, Service } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { TuiNotificationService } from '@taiga-ui/core';
import { PolymorpheusComponent } from '@taiga-ui/polymorpheus';
import { filter, firstValueFrom, type Subscription } from 'rxjs';
import { ConfigService } from '../../core/ipc/config';
import { type EditedFile, ExternalEditsIpc } from '../../core/ipc/external-edits';
import { IpcError } from '../../core/ipc/ipc-error';
import { SshService } from '../../core/ipc/ssh';
import { isFinished } from '../../core/ipc/transfers';
import { type UpdateInfo, type UpdateProgress, UpdatesIpc } from '../../core/ipc/updates';
import { confirmDestructive } from '../../shared/destructive-confirm/confirm-destructive';
import { OpenDialogs } from '../../shared/open-dialogs';
import { notifyError } from '../../shared/save-error';
import { uiText } from '../../shared/ui-text';
import { notUploadedNames } from '../external-editor/edited-view';
import { TransferQueue } from '../transfers/transfer-queue';
import { unsavedNames } from '../workspace/tab-titles';
import { Workspace, type WorkspaceTab } from '../workspace/workspace';
import type { UpdateErrorData } from './update-error/update-error';
import { type UpdateFailure, type UpdateFailureKind, UpdateStore } from './update-store';
import { failureView, restartRequired, updateErrorText } from './update-text';

/** Progress repaints at most this often. */
export const PROGRESS_INTERVAL_MS = 250;

export interface RestartImpact {
  readonly connections: number;
  readonly transfers: number;
  readonly dialog: boolean;
}

/**
 * Drives the update phase: automatic and manual checks, the notice, download, the restart
 * decision and install. Everything the user sees reads `UpdateStore`.
 */
@Service()
export class UpdateFlow {
  private readonly ipc = inject(UpdatesIpc);
  private readonly store = inject(UpdateStore);
  private readonly alerts = inject(TuiNotificationService);
  private readonly dialogs = inject(OpenDialogs);
  private readonly config = inject(ConfigService);
  private readonly workspace = inject(Workspace);
  private readonly external = inject(ExternalEditsIpc);
  private readonly ssh = inject(SshService);
  private readonly transfers = inject(TransferQueue);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  private readonly document = inject(DOCUMENT);

  readonly windows = /Windows/i.test(this.document.defaultView?.navigator.userAgent ?? '');
  /** What a restart would close now; shown while Ready, evaluated again at each attempt. */
  readonly impact = computed<RestartImpact>(() => ({
    connections: Object.values(this.ssh.states()).filter((s) => s === 'connected').length,
    transfers: this.transfers.transfers().filter((t) => !isFinished(t.state)).length,
    dialog: !this.dialogs.none(),
  }));

  private readonly ready = computed(() => this.config.loaded() && this.dialogs.none());
  private started: Promise<void> | null = null;
  private checking: Promise<void> | null = null;
  private notice: Subscription | null = null;
  private noticeOpening = false;
  private errorNotice: Subscription | null = null;
  /** The version closed with Later (or Download) this run. */
  private dismissed: string | null = null;
  /** Versions refused for their signature this run: never re-offered automatically. */
  private readonly refused = new Set<string>();

  start(): Promise<void> {
    this.started ??= this.run();
    return this.started;
  }

  private async run(): Promise<void> {
    try {
      const state = await this.ipc.state();
      this.store.state.set(state);
      if (state.available && !this.store.offer()) {
        this.offer(state.available);
      }
    } catch {
      return;
    }
    await this.ipc
      .subscribe((event) => {
        if (event.kind === 'available') {
          this.found(event.info);
        }
      })
      .catch(() => undefined);
  }

  /** An automatic result: skipped, refused and dismissed versions get no notice. */
  private found(info: UpdateInfo): void {
    if (this.refused.has(info.version) || info.version === this.store.state()?.skippedVersion) {
      return;
    }
    if (this.store.busy() && this.store.offer()?.version !== info.version) {
      return;
    }
    if (this.store.offer()?.version !== info.version) {
      this.offer(info);
    }
    if (this.dismissed !== info.version) {
      void this.showNotice();
    }
  }

  private offer(info: UpdateInfo): void {
    this.store.offer.set(info);
    this.store.phase.set('available');
    const failure = this.store.failure();
    if (failure && failure.kind !== 'check') {
      this.store.failure.set(null);
    }
  }

  /** Check now; a second click while checking joins the first. */
  check(): Promise<void> {
    this.checking ??= this.runCheck().finally(() => (this.checking = null));
    return this.checking;
  }

  private async runCheck(): Promise<void> {
    this.store.check.set('checking');
    if (this.store.failure()?.kind === 'check') {
      this.store.failure.set(null);
    }
    let info: UpdateInfo | null;
    try {
      info = await this.ipc.check();
    } catch (err) {
      if (err instanceof IpcError && err.code === 'not_found') {
        info = null;
      } else {
        this.store.check.set('idle');
        if (err instanceof IpcError && err.code === 'unsupported') {
          this.store.unsupported.set(true);
        } else {
          this.store.failure.set({ kind: 'check', error: err });
        }
        return;
      }
    }
    await this.refreshState();
    if (info) {
      this.refused.delete(info.version);
      if (!this.store.busy()) {
        this.offer(info);
      }
      this.store.check.set('idle');
      // A manual check shows the notice even for a skipped or dismissed version.
      void this.showNotice();
    } else {
      this.store.check.set('upToDate');
      if (!this.store.busy()) {
        this.clearOffer();
      }
    }
  }

  /** Saved at once; false when the save failed (the caller shows the stored value again). */
  async setAutoCheck(enabled: boolean): Promise<boolean> {
    try {
      this.store.state.set(await this.ipc.setAutoCheck(enabled));
    } catch (err) {
      notifyError(this.alerts, err, uiText('settings.notSaved'));
      return false;
    }
    if (enabled) {
      void this.silentCheck();
    }
    return true;
  }

  /** Turning the automatic check on runs one at once, treated as automatic: failures say nothing. */
  private async silentCheck(): Promise<void> {
    try {
      const info = await this.ipc.check();
      await this.refreshState();
      if (info) {
        this.found(info);
      } else if (!this.store.busy()) {
        this.clearOffer();
      }
    } catch {
      return;
    }
  }

  async skip(): Promise<void> {
    const offer = this.store.offer();
    if (!offer) {
      return;
    }
    try {
      this.store.state.set(await this.ipc.skip(offer.version));
      this.closeNotice();
    } catch (err) {
      notifyError(this.alerts, err, uiText('settings.notSaved'));
    }
  }

  later(): void {
    this.dismissed = this.store.offer()?.version ?? null;
    this.closeNotice();
  }

  /** Update, Download and Retry. */
  async update(): Promise<void> {
    const offer = this.store.offer();
    if (!offer || this.store.busy()) {
      return;
    }
    if (this.store.downloadOnly()) {
      this.later();
      await this.openReleasePage(offer.version);
      return;
    }
    this.closeErrorNotice();
    this.store.failure.set(null);
    this.store.phase.set('downloading');
    this.store.progress.set({ downloaded: 0, total: null });
    let shown = 0;
    try {
      await this.ipc.download((progress) => {
        const now = Date.now();
        const done = progress.total !== null && progress.downloaded >= progress.total;
        if (done || now - shown >= PROGRESS_INTERVAL_MS) {
          shown = now;
          this.progress(progress);
        }
      });
    } catch (err) {
      this.downloadFailed(offer.version, err);
      return;
    }
    this.store.progress.set(null);
    await this.decide(false);
  }

  private progress(progress: UpdateProgress): void {
    this.store.progress.set(progress);
    if (progress.total !== null && progress.downloaded >= progress.total) {
      this.store.phase.set('verifying');
    }
  }

  async cancel(): Promise<void> {
    await this.ipc.cancelDownload().catch(() => undefined);
  }

  /** Restart now: the Ready notice already named what closes. */
  restartNow(): Promise<void> {
    return this.decide(true);
  }

  /**
   * Nothing open: install at once. Unsaved editors or files not uploaded: the quit confirm.
   * Only connections, transfers or a dialog: pause at Ready (unless the user is past it).
   */
  private async decide(pastReady: boolean): Promise<void> {
    const impact = this.impact();
    const modified = this.workspace.tabs().filter((t) => t.modified());
    const pending = await this.notUploaded();
    if (modified.length || pending.length) {
      if (await this.confirmUnsaved(modified, pending, impact)) {
        await this.install(pending.length > 0);
        return;
      }
      this.store.phase.set('ready');
      void this.showNotice();
      if (modified.length) {
        await this.workspace.activate(modified[0]);
      } else {
        await this.router.navigate(['/edited-files']);
      }
      return;
    }
    if (!pastReady && (impact.connections || impact.transfers || impact.dialog)) {
      this.store.phase.set('ready');
      void this.showNotice();
      return;
    }
    await this.install(false);
  }

  private confirmUnsaved(
    modified: WorkspaceTab[],
    pending: EditedFile[],
    impact: RestartImpact,
  ): Promise<boolean> {
    const hostName = (id: string) =>
      this.config.findHost(id)?.host.name ?? uiText('workspace.tab.unknownHost');
    const lines = [
      modified.length
        ? uiText('workspace.unsaved.quitUnsaved', { names: unsavedNames(modified, hostName) })
        : '',
      pending.length
        ? uiText('workspace.unsaved.quitNotUploaded', {
            names: notUploadedNames(pending, hostName),
          })
        : '',
      impact.connections
        ? uiText('updates.notice.impactConnections', { count: impact.connections })
        : '',
      impact.transfers ? uiText('updates.notice.impactTransfers', { count: impact.transfers }) : '',
    ].filter(Boolean);
    return confirmDestructive(
      this.dialogs,
      uiText('workspace.unsaved.quitTitle'),
      {
        content: lines.join(' '),
        lines,
        yes: uiText('workspace.unsaved.quitYes'),
        no: uiText('common.cancel'),
      },
      'm',
    );
  }

  private async install(stopEditing: boolean): Promise<void> {
    const version = this.store.offer()?.version ?? '';
    this.store.phase.set('installing');
    if (stopEditing) {
      await this.external.stopAll(true).catch(() => undefined);
    }
    try {
      // Every caller decided first: nothing open, the confirm accepted, or Restart now.
      await this.ipc.apply(true);
    } catch (err) {
      if (err instanceof IpcError && err.code === 'signature_invalid') {
        this.refuse(version);
        return;
      }
      this.store.phase.set('ready');
      this.fail({ kind: 'install', error: err });
    }
  }

  private downloadFailed(version: string, err: unknown): void {
    this.store.progress.set(null);
    if (err instanceof IpcError && err.code === 'signature_invalid') {
      this.refuse(version);
      return;
    }
    this.store.phase.set('available');
    this.closeNotice();
    if (!(err instanceof IpcError && err.code === 'cancelled')) {
      this.fail({ kind: 'download', error: err });
    }
  }

  private refuse(version: string): void {
    this.refused.add(version);
    this.clearOffer();
    this.fail({ kind: 'signature', error: null });
  }

  private fail(failure: UpdateFailure): void {
    this.store.failure.set(failure);
    this.closeNotice();
    void this.showError(failure);
  }

  private clearOffer(): void {
    this.store.offer.set(null);
    this.store.phase.set(null);
    this.store.progress.set(null);
  }

  private async refreshState(): Promise<void> {
    try {
      this.store.state.set(await this.ipc.state());
    } catch {
      return;
    }
  }

  async openReleasePage(
    version = this.store.offer()?.version ?? this.store.state()?.current,
  ): Promise<void> {
    if (!version) {
      return;
    }
    try {
      await this.ipc.openReleaseNotes(version);
    } catch (err) {
      this.alerts
        .open(updateErrorText(err), {
          label: uiText('updates.error.pageNotOpened'),
          appearance: 'negative',
        })
        .subscribe();
    }
  }

  /** Waits for no open dialog (the consent dialog first at first launch); never takes focus. */
  private async showNotice(): Promise<void> {
    if (this.notice || this.noticeOpening) {
      return;
    }
    this.noticeOpening = true;
    try {
      const { UpdateNotice } = await import('./update-notice/update-notice');
      while (!this.ready()) {
        await firstValueFrom(
          toObservable(this.ready, { injector: this.injector }).pipe(filter(Boolean)),
        );
      }
      if (!this.store.offer() && this.store.phase() === null) {
        return;
      }
      this.notice = this.alerts
        .open(new PolymorpheusComponent(UpdateNotice), {
          appearance: 'info',
          autoClose: 0,
          closable: false,
          block: 'end',
        })
        .subscribe({ complete: () => (this.notice = null) });
    } finally {
      this.noticeOpening = false;
    }
  }

  closeNotice(): void {
    if (!this.notice) {
      return;
    }
    const focused = this.document.activeElement?.closest('[data-testid="update-notice"]');
    this.notice.unsubscribe();
    this.notice = null;
    if (focused) {
      this.document.querySelector<HTMLElement>('[data-testid="settings"]')?.focus();
    }
  }

  private async showError(failure: UpdateFailure): Promise<void> {
    this.closeErrorNotice();
    const { UpdateError } = await import('./update-error/update-error');
    const view = failureView(failure);
    const data: UpdateErrorData = {
      kind: failure.kind,
      text: view.text,
      action: errorAction(failure),
      run: () => this.runErrorAction(failure.kind),
    };
    this.errorNotice = this.alerts
      .open(new PolymorpheusComponent(UpdateError), {
        appearance: 'negative',
        label: view.title,
        closable: true,
        autoClose: 0,
        block: 'end',
        ...(failure.kind === 'signature' ? { icon: '@tui.shield-x' } : {}),
        data,
      })
      .subscribe({ complete: () => (this.errorNotice = null) });
  }

  private runErrorAction(kind: UpdateFailureKind): void {
    this.closeErrorNotice();
    if (kind === 'download') {
      void this.update();
    } else {
      void this.openReleasePage();
    }
  }

  private closeErrorNotice(): void {
    this.errorNotice?.unsubscribe();
    this.errorNotice = null;
  }

  private async notUploaded(): Promise<EditedFile[]> {
    const files = await this.external.list().catch(() => []);
    return files.filter((f) => f.notUploaded);
  }
}

/** Retry after a download error, the release page after an install error; a refusal gets none. */
function errorAction(failure: UpdateFailure): UpdateErrorData['action'] {
  switch (failure.kind) {
    case 'download':
      return 'retry';
    case 'install':
      return restartRequired(failure) ? null : 'releasePage';
    default:
      return null;
  }
}
