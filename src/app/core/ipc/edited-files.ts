import { computed, inject, Service, signal } from '@angular/core';
import { ReplaySubject, Subject } from 'rxjs';
import { ConfigService } from './config';
import {
  type EditedEvent,
  type EditedFile,
  type EditedState,
  ExternalEditsIpc,
} from './external-edits';

/** A file whose state changed; `previous` is null for a file seen for the first time. */
export interface EditedChange {
  readonly previous: EditedFile | null;
  readonly file: EditedFile;
}

/** Rows needing attention come first, in this order (UX spec R1). */
const ATTENTION_ORDER: readonly EditedState[] = ['conflict', 'failed', 'waiting', 'recovered'];

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Attention first, then the rest; each group by host name, then remote path. */
export function sortEdited(
  files: readonly EditedFile[],
  hostName: (hostId: string) => string,
): EditedFile[] {
  const rank = (f: EditedFile) => {
    const index = ATTENTION_ORDER.indexOf(f.state);
    return index < 0 ? ATTENTION_ORDER.length : index;
  };
  return [...files].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      collator.compare(hostName(a.hostId), hostName(b.hostId)) ||
      collator.compare(a.remotePath, b.remotePath),
  );
}

/**
 * The files open in an external editor, kept live from the backend's single subscription.
 * Started once from the app initializer.
 */
@Service()
export class EditedFiles {
  private readonly ipc = inject(ExternalEditsIpc);
  private readonly config = inject(ConfigService);
  private readonly byId = signal<ReadonlyMap<string, EditedFile>>(new Map());
  private started = false;
  private buffered: EditedEvent[] | null = null;

  readonly loaded = signal(false);
  readonly files = computed(() =>
    sortEdited([...this.byId().values()], (id) => this.config.findHost(id)?.host.name ?? ''),
  );
  readonly count = computed(() => this.byId().size);
  readonly attention = computed(() => this.files().filter((f) => f.needsAttention).length);
  /** State changes coming from the backend (not from `upsert`). */
  readonly changes = new Subject<EditedChange>();
  /** The list found at startup, once. */
  readonly snapshot = new ReplaySubject<readonly EditedFile[]>(1);
  /** The Edited files page focuses this row's action when it is rendered. */
  readonly focusRequest = signal<{ readonly id: string } | null>(null);

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    // Events can arrive before the snapshot resolves: they are applied on top of it.
    this.buffered = [];
    try {
      const list = await this.ipc.subscribe((event) => this.onEvent(event));
      this.byId.set(new Map(list.map((f) => [f.id, f])));
      const pending = this.buffered ?? [];
      this.buffered = null;
      pending.forEach((event) => this.apply(event));
      this.loaded.set(true);
      this.snapshot.next(list);
    } catch {
      this.buffered = null;
      this.started = false;
    }
  }

  find(id: string): EditedFile | null {
    return this.byId().get(id) ?? null;
  }

  /** Files of one host by remote path, for the remote pane markers. */
  ofHost(hostId: string): ReadonlyMap<string, EditedFile> {
    return new Map(
      [...this.byId().values()].filter((f) => f.hostId === hostId).map((f) => [f.remotePath, f]),
    );
  }

  findByPath(hostId: string, path: string): EditedFile | null {
    return (
      [...this.byId().values()].find((f) => f.hostId === hostId && f.remotePath === path) ?? null
    );
  }

  /** A command result: same data as the event that follows, applied without waiting. */
  upsert(file: EditedFile): void {
    this.byId.update((map) => new Map(map).set(file.id, file));
  }

  remove(ids: Iterable<string>): void {
    const gone = new Set(ids);
    if ([...gone].some((id) => this.byId().has(id))) {
      this.byId.update((map) => new Map([...map].filter(([id]) => !gone.has(id))));
    }
  }

  /** Replaces everything, after a bulk change such as Stop all. */
  reset(list: readonly EditedFile[]): void {
    this.byId.set(new Map(list.map((f) => [f.id, f])));
  }

  private onEvent(event: EditedEvent): void {
    if (this.buffered) {
      this.buffered.push(event);
      return;
    }
    this.apply(event);
  }

  private apply(event: EditedEvent): void {
    if (event.kind === 'removed') {
      this.remove([event.id]);
      return;
    }
    const previous = this.find(event.file.id);
    this.upsert(event.file);
    if (previous?.state !== event.file.state || previous.error?.code !== event.file.error?.code) {
      this.changes.next({ previous, file: event.file });
    }
  }
}
