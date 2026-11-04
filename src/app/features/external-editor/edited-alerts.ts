import { DestroyRef, effect, inject, Service } from '@angular/core';
import { TuiNotificationService } from '@taiga-ui/core';
import { PolymorpheusComponent } from '@taiga-ui/polymorpheus';
import { type Subscription, take } from 'rxjs';
import { ConfigService } from '../../core/ipc/config';
import { type EditedChange, EditedFiles } from '../../core/ipc/edited-files';
import type { EditedFile, EditedState } from '../../core/ipc/external-edits';
import { AlertAction, type AlertActionData } from '../../shared/alert-action/alert-action';
import { EditedActions } from './edited-actions';
import { failureReason, hostName } from './edited-view';

/** Files of one host entering the same state within this window share one alert. */
export const GROUP_WINDOW_MS = 2000;

type AlertState = 'conflict' | 'failed' | 'waiting';

interface OpenAlert {
  readonly state: EditedState;
  readonly ids: readonly string[];
  readonly subscription: Subscription;
}

interface Batch {
  readonly state: AlertState;
  readonly hostId: string;
  readonly files: EditedFile[];
}

/**
 * Alerts for edited files that need the user (spec R5): conflict, failed upload, changes waiting
 * while the window is in the background, leftovers recovered at startup. Successful uploads stay
 * silent. The taskbar flash is requested by the backend.
 */
@Service()
export class EditedAlerts {
  private readonly store = inject(EditedFiles);
  private readonly alerts = inject(TuiNotificationService);
  private readonly config = inject(ConfigService);
  private readonly actions = inject(EditedActions);
  private readonly destroyRef = inject(DestroyRef);
  private readonly batches = new Map<string, Batch>();
  /** Last failure code alerted per file: the same failure again stays inline only. */
  private readonly failures = new Map<string, string>();
  /** Hosts whose waiting changes were already announced since they disconnected. */
  private readonly waitingHosts = new Set<string>();
  /** Alerts on screen: closed when all their files leave the state, or on Review. */
  private readonly open = new Set<OpenAlert>();
  private started = false;

  constructor() {
    effect(() => {
      this.store.files();
      this.prune();
    });
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    const changes = this.store.changes.subscribe((change) => this.onChange(change));
    const snapshot = this.store.snapshot.pipe(take(1)).subscribe((list) => this.onSnapshot(list));
    this.destroyRef.onDestroy(() => {
      changes.unsubscribe();
      snapshot.unsubscribe();
      this.open.forEach((alert) => alert.subscription.unsubscribe());
    });
  }

  private onChange({ previous, file }: EditedChange): void {
    if (file.state === 'synced') {
      this.failures.delete(file.id);
    }
    if (file.state === 'synced' || file.state === 'uploading') {
      this.waitingHosts.delete(file.hostId);
    }
    switch (file.state) {
      case 'conflict':
        if (previous?.state !== 'conflict') {
          this.queue('conflict', file);
        }
        return;
      case 'failed': {
        const code = file.error?.code ?? '';
        if (this.failures.get(file.id) !== code) {
          this.failures.set(file.id, code);
          this.queue('failed', file);
        }
        return;
      }
      case 'waiting':
        if (
          previous?.state !== 'waiting' &&
          !document.hasFocus() &&
          !this.waitingHosts.has(file.hostId)
        ) {
          this.waitingHosts.add(file.hostId);
          this.queue('waiting', file);
        }
        return;
    }
  }

  private onSnapshot(list: readonly EditedFile[]): void {
    const recovered = list.filter((f) => f.state === 'recovered');
    if (!recovered.length) {
      return;
    }
    const label =
      recovered.length === 1
        ? '1 edited file was not uploaded'
        : `${recovered.length} edited files were not uploaded`;
    this.show(
      'recovered',
      recovered,
      label,
      'Carapace closed before the changes reached the server.',
      'warning',
      0,
      () => this.actions.review(recovered.length === 1 ? recovered[0].id : null),
    );
  }

  private queue(state: AlertState, file: EditedFile): void {
    const key = `${state}:${file.hostId}`;
    const batch = this.batches.get(key);
    if (batch) {
      batch.files.push(file);
      return;
    }
    this.batches.set(key, { state, hostId: file.hostId, files: [file] });
    setTimeout(() => this.flush(key), GROUP_WINDOW_MS);
  }

  private flush(key: string): void {
    const batch = this.batches.get(key);
    this.batches.delete(key);
    if (!batch) {
      return;
    }
    const files = batch.files.filter((f) => this.store.find(f.id)?.state === batch.state);
    if (!files.length) {
      return;
    }
    const host = hostName(this.config, batch.hostId);
    const one = files.length === 1 ? files[0] : null;
    const review = () => this.actions.review(one?.id ?? null);
    switch (batch.state) {
      case 'conflict':
        this.show(
          batch.state,
          files,
          one ? `${one.name} changed on ${host}` : `${files.length} files changed on ${host}`,
          one ? 'Your last save was not uploaded.' : 'Your last saves were not uploaded.',
          'warning',
          0,
          review,
        );
        return;
      case 'failed':
        this.show(
          batch.state,
          files,
          one ? `${one.name} not uploaded` : `${files.length} files not uploaded`,
          (one &&
            failureReason(
              this.store.find(one.id) ?? one,
              this.config.findHost(batch.hostId)?.host.name ?? null,
            )) ??
            `The uploads to ${host} failed.`,
          'negative',
          0,
          review,
        );
        return;
      case 'waiting':
        this.show(
          batch.state,
          files,
          one
            ? `Changes to ${one.name} are waiting for ${host}`
            : `Changes to ${files.length} files are waiting for ${host}`,
          'Reconnect to upload them.',
          'neutral',
          undefined,
          review,
        );
        return;
    }
  }

  private show(
    state: EditedState,
    files: readonly EditedFile[],
    label: string,
    text: string,
    appearance: string,
    autoClose: number | undefined,
    review: () => Promise<void>,
  ): void {
    const ids = files.map((f) => f.id);
    let entry: OpenAlert | null = null;
    let done = false;
    const close = () => {
      done = true;
      subscription.unsubscribe();
      if (entry) {
        this.open.delete(entry);
      }
    };
    const subscription = this.alerts
      .open(new PolymorpheusComponent(AlertAction), {
        label,
        appearance,
        ...(autoClose === undefined ? {} : { autoClose }),
        data: {
          text,
          action: 'Review',
          testId: 'edited-review',
          run: () => {
            close();
            void review();
          },
        } satisfies AlertActionData,
      })
      .subscribe({
        complete: () => {
          done = true;
          if (entry) {
            this.open.delete(entry);
          }
        },
      });
    if (!done) {
      entry = { state, ids, subscription };
      this.open.add(entry);
    }
  }

  /** Closes the alerts whose files all left the state they announced. */
  private prune(): void {
    for (const alert of this.open) {
      if (!alert.ids.some((id) => this.store.find(id)?.state === alert.state)) {
        alert.subscription.unsubscribe();
        this.open.delete(alert);
      }
    }
  }
}
