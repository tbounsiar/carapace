import { computed, inject, Service, signal, type Signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import { filter, map } from 'rxjs';
import type { EditorDoc } from '../editor/editor-docs';
import type { TerminalTab } from '../terminal/terminal-sessions';
import type { TabStatus } from './tab-status';

export type TabKind = 'terminal' | 'files' | 'edit';

export interface WorkspaceTab {
  /** Route id: `/tabs/:id`. */
  readonly id: string;
  /** `terminal:{hostId}:{n}`, `files:{hostId}` or `edit:{hostId}:{path}`. */
  readonly key: string;
  readonly kind: TabKind;
  readonly hostId: string;
  /** "Terminal 2", "Files" or the file name. */
  readonly label: string;
  /** Remote absolute path of an editor tab. */
  readonly path: string | null;
  readonly status: Signal<TabStatus>;
  readonly modified: Signal<boolean>;
  readonly readOnly: Signal<boolean>;
  readonly terminal: TerminalTab | null;
  readonly doc: EditorDoc | null;
}

export interface TabSpec {
  readonly key: string;
  readonly kind: TabKind;
  readonly hostId: string;
  readonly label: string;
  readonly path?: string | null;
  readonly status: Signal<TabStatus>;
  readonly modified?: Signal<boolean>;
  readonly readOnly?: Signal<boolean>;
  readonly terminal?: TerminalTab | null;
  readonly doc?: EditorDoc | null;
  /** Releases what the tab holds (the shell, the buffer) when it is removed. */
  readonly dispose?: () => void;
}

const NO = signal(false).asReadonly();

export function tabKey(kind: 'files', hostId: string): string;
export function tabKey(kind: 'terminal', hostId: string, n: number): string;
export function tabKey(kind: 'edit', hostId: string, path: string): string;
export function tabKey(kind: TabKind, hostId: string, extra?: number | string): string {
  return extra === undefined ? `${kind}:${hostId}` : `${kind}:${hostId}:${extra}`;
}

function tabRoute(url: string): string | null {
  const segments = url.split(/[?#]/)[0].split('/').filter(Boolean);
  return segments.length === 2 && segments[0] === 'tabs' ? decodeURIComponent(segments[1]) : null;
}

/**
 * The open terminals, file explorers and editors of every host, in strip order. In memory only:
 * the tabs, and the editor buffers they hold, are gone when the app quits.
 */
@Service()
export class Workspace {
  private readonly router = inject(Router);
  private readonly _tabs = signal<readonly WorkspaceTab[]>([]);
  private readonly stamps = signal<ReadonlyMap<string, number>>(new Map());
  private readonly disposers = new Map<string, () => void>();
  private nextId = 1;
  private clock = 0;

  private readonly url = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => e.urlAfterRedirects),
    ),
    { initialValue: this.router.url },
  );

  readonly tabs = this._tabs.asReadonly();
  /** The tab id of the current route, whether or not that tab still exists. */
  readonly routedId = computed(() => tabRoute(this.url()));
  readonly active = computed(() => {
    const id = this.routedId();
    return id ? (this._tabs().find((t) => t.id === id) ?? null) : null;
  });
  /** Bumped when the active tab's content should take the focus. */
  readonly focusRequest = signal(0);
  /** Set when the last tab closed and focus should land on the host page heading. */
  readonly headingFocus = signal(false);

  find(id: string): WorkspaceTab | null {
    return this._tabs().find((t) => t.id === id) ?? null;
  }

  byKey(key: string): WorkspaceTab | null {
    return this._tabs().find((t) => t.key === key) ?? null;
  }

  ofHost(hostId: string): WorkspaceTab[] {
    return this._tabs().filter((t) => t.hostId === hostId);
  }

  lastActivated(tab: WorkspaceTab): number {
    return this.stamps().get(tab.id) ?? 0;
  }

  /** The tab of `hostId` and `kind` activated most recently among those `accept` keeps. */
  mostRecent(
    hostId: string,
    kind: TabKind,
    accept: (tab: WorkspaceTab) => boolean = () => true,
  ): WorkspaceTab | null {
    let best: WorkspaceTab | null = null;
    for (const tab of this._tabs()) {
      if (tab.hostId === hostId && tab.kind === kind && accept(tab)) {
        if (!best || this.lastActivated(tab) >= this.lastActivated(best)) {
          best = tab;
        }
      }
    }
    return best;
  }

  /** Inserted right after the last tab of the same host, else at the end. */
  add(spec: TabSpec): WorkspaceTab {
    const tab: WorkspaceTab = {
      id: `t${this.nextId++}`,
      key: spec.key,
      kind: spec.kind,
      hostId: spec.hostId,
      label: spec.label,
      path: spec.path ?? null,
      status: spec.status,
      modified: spec.modified ?? NO,
      readOnly: spec.readOnly ?? NO,
      terminal: spec.terminal ?? null,
      doc: spec.doc ?? null,
    };
    if (spec.dispose) {
      this.disposers.set(tab.id, spec.dispose);
    }
    this._tabs.update((tabs) => {
      let at = -1;
      tabs.forEach((t, i) => {
        if (t.hostId === tab.hostId) {
          at = i;
        }
      });
      return at < 0 ? [...tabs, tab] : [...tabs.slice(0, at + 1), tab, ...tabs.slice(at + 1)];
    });
    return tab;
  }

  /** Routes to the tab and moves the focus into its content. Resolves false if a guard refused. */
  async activate(tab: WorkspaceTab): Promise<boolean> {
    this.stamps.update((stamps) => new Map(stamps).set(tab.id, ++this.clock));
    const routed = this.routedId() === tab.id || (await this.router.navigate(['/tabs', tab.id]));
    if (routed) {
      this.focusRequest.update((n) => n + 1);
    }
    return routed !== false;
  }

  /** Removes without asking. Closing the routed tab activates its right neighbour, else the left one. */
  async remove(tab: WorkspaceTab): Promise<void> {
    const tabs = this._tabs();
    const index = tabs.findIndex((t) => t.id === tab.id);
    if (index < 0) {
      return;
    }
    if (this.routedId() === tab.id) {
      const next = tabs[index + 1] ?? tabs[index - 1];
      if (next) {
        await this.activate(next);
      } else {
        this.headingFocus.set(true);
        await this.router.navigate(['/hosts', tab.hostId]);
      }
    }
    this.drop([tab.id]);
  }

  /** Removes several tabs at once, without routing (their host is gone or the route moves anyway). */
  drop(ids: readonly string[]): void {
    const gone = new Set(ids);
    this._tabs.update((tabs) => tabs.filter((t) => !gone.has(t.id)));
    this.stamps.update((stamps) => {
      const next = new Map(stamps);
      ids.forEach((id) => next.delete(id));
      return next;
    });
    for (const id of ids) {
      const dispose = this.disposers.get(id);
      this.disposers.delete(id);
      dispose?.();
    }
  }
}
