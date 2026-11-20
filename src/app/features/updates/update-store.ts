import { computed, Service, signal } from '@angular/core';
import type { UpdateInfo, UpdateProgress, UpdateState } from '../../core/ipc/updates';

/** Where the offered version is; null when nothing is offered. */
export type OfferPhase = 'available' | 'downloading' | 'verifying' | 'ready' | 'installing';

export type CheckStatus = 'idle' | 'checking' | 'upToDate';

export type UpdateFailureKind = 'check' | 'download' | 'signature' | 'install';

export interface UpdateFailure {
  readonly kind: UpdateFailureKind;
  readonly error: unknown;
}

const BUSY: readonly OfferPhase[] = ['downloading', 'verifying', 'installing'];

/**
 * The one update phase of the app, read by the notice, Settings and the aside badge. Kept apart
 * from `UpdateFlow` so the badge stays in the initial bundle without the flow's dependencies.
 */
@Service()
export class UpdateStore {
  readonly state = signal<UpdateState | null>(null);
  readonly offer = signal<UpdateInfo | null>(null);
  readonly phase = signal<OfferPhase | null>(null);
  readonly progress = signal<UpdateProgress | null>(null);
  readonly check = signal<CheckStatus>('idle');
  readonly failure = signal<UpdateFailure | null>(null);
  /** A check answered `unsupported`: this build cannot check. */
  readonly unsupported = signal(false);

  readonly skipped = computed(() => {
    const offer = this.offer();
    return offer !== null && offer.version === this.state()?.skippedVersion;
  });
  readonly busy = computed(() => {
    const phase = this.phase();
    return phase !== null && BUSY.includes(phase);
  });
  readonly downloadOnly = computed(() => this.state()?.installKind === 'downloadOnly');
  readonly badge = computed(
    () => this.phase() === 'ready' || (this.offer() !== null && !this.skipped()),
  );
}
