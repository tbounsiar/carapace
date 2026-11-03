import { inject, Service, signal, type Signal } from '@angular/core';
import { TuiNotificationService } from '@taiga-ui/core';
import type { EffectiveTheme } from '../../core/theme/theme';
import { IpcError } from '../../core/ipc/ipc-error';
import {
  TerminalIpc,
  type TerminalClosedReason,
  type TerminalEvent,
} from '../../core/ipc/terminal';
import { notifyError } from '../project-tree/save-error';
import { DEFAULT_FONT_SIZE } from '../../core/settings/settings';
import { type XtermAppearance, XtermFactory, type XtermView } from './xterm-factory';
import { xtermFont, xtermTheme } from './xterm-theme';

export type TerminalTabState = 'opening' | 'open' | 'ended';

export interface TerminalTab {
  /** Unique across connections, for `track`. */
  readonly key: number;
  readonly connectionId: string;
  /** "Terminal N", increments per connection and is never reused. */
  readonly n: number;
  readonly state: Signal<TerminalTabState>;
  readonly reason: Signal<TerminalClosedReason | null>;
}

interface Run {
  terminalId: string | null;
  cancelled: boolean;
}

class Session implements TerminalTab {
  readonly state = signal<TerminalTabState>('opening');
  readonly reason = signal<TerminalClosedReason | null>(null);
  readonly element = document.createElement('div');
  run: Run | null = null;
  queue: Promise<unknown> = Promise.resolve();
  opened = false;
  disposed = false;
  sentSize = { cols: 0, rows: 0 };

  constructor(
    readonly key: number,
    readonly connectionId: string,
    readonly n: number,
    readonly view: XtermView,
  ) {
    this.element.className = 'terminal-host';
  }
}

const DEFAULT_SIZE = { cols: 80, rows: 24 };

/** Terminal tabs per connection, kept here (not in the panel) so their xterm and scrollback outlive navigation. */
@Service()
export class TerminalSessions {
  private readonly ipc = inject(TerminalIpc);
  private readonly factory = inject(XtermFactory);
  private readonly alerts = inject(TuiNotificationService);

  private readonly _tabs = signal<Readonly<Record<string, readonly Session[]>>>({});
  private readonly _active = signal<Readonly<Record<string, number>>>({});
  private readonly counters = new Map<string, number>();
  private nextKey = 1;
  private appearance: XtermAppearance = {
    theme: {},
    fontFamily: 'monospace',
    fontSize: DEFAULT_FONT_SIZE,
  };

  tabs(connectionId: string): readonly TerminalTab[] {
    return this._tabs()[connectionId] ?? [];
  }

  active(connectionId: string): TerminalTab | null {
    const tabs = this._tabs()[connectionId] ?? [];
    return tabs.find((tab) => tab.key === this._active()[connectionId]) ?? tabs.at(-1) ?? null;
  }

  select(tab: TerminalTab): void {
    this._active.update((active) => ({ ...active, [tab.connectionId]: tab.key }));
  }

  async open(connectionId: string): Promise<TerminalTab | null> {
    let view: XtermView;
    try {
      view = await this.factory.create(this.appearance);
    } catch {
      this.alerts
        .open('The terminal component could not be loaded. Restart the app and try again.', {
          label: 'Terminal not opened',
          appearance: 'negative',
        })
        .subscribe();
      return null;
    }
    const n = (this.counters.get(connectionId) ?? 0) + 1;
    this.counters.set(connectionId, n);
    const session = new Session(this.nextKey++, connectionId, n, view);
    session.view.onData((data) => this.send(session, data));
    session.view.onResize(() => this.syncSize(session));
    this._tabs.update((tabs) => ({
      ...tabs,
      [connectionId]: [...(tabs[connectionId] ?? []), session],
    }));
    this.select(session);
    if (await this.start(session)) {
      return session;
    }
    if (!session.disposed) {
      this.remove(session);
    }
    return null;
  }

  /** Opens a new shell in an ended tab; the old scrollback stays above it. */
  async reopen(tab: TerminalTab): Promise<void> {
    const session = this.session(tab);
    if (!session || session.state() !== 'ended') {
      return;
    }
    session.view.write('\r\n');
    session.state.set('opening');
    session.reason.set(null);
    if (!(await this.start(session)) && !session.disposed) {
      session.state.set('ended');
      session.reason.set('closed');
    }
  }

  async close(tab: TerminalTab): Promise<void> {
    const session = this.session(tab);
    if (!session) {
      return;
    }
    const terminalId = session.run?.terminalId ?? null;
    if (session.run) {
      session.run.cancelled = true;
    }
    session.run = null;
    this.remove(session);
    if (terminalId && session.state() !== 'ended') {
      try {
        await this.ipc.close(terminalId);
      } catch (err) {
        if (!(err instanceof IpcError && err.code === 'not_found')) {
          notifyError(this.alerts, err, 'Terminal not closed');
        }
      }
    }
  }

  attach(tab: TerminalTab, container: HTMLElement): void {
    const session = this.session(tab);
    if (!session) {
      return;
    }
    if (session.element.parentElement !== container) {
      container.replaceChildren(session.element);
    }
    if (!session.opened) {
      session.opened = true;
      session.view.open(session.element);
    }
    session.view.fit();
    session.view.focus();
  }

  detach(tab: TerminalTab): void {
    this.session(tab)?.element.remove();
  }

  fit(tab: TerminalTab): void {
    this.session(tab)?.view.fit();
  }

  /** `source` must sit inside the themed `tui-root` so the Taiga tokens resolve for `effective`. */
  applyAppearance(source: Element, effective: EffectiveTheme, fontSize: number): void {
    this.appearance = {
      theme: xtermTheme(source, effective),
      fontFamily: xtermFont(source),
      fontSize,
    };
    for (const sessions of Object.values(this._tabs())) {
      for (const session of sessions) {
        session.view.setAppearance(this.appearance);
        // A new font size changes the cell size, so the rows and columns must be refitted.
        session.view.fit();
      }
    }
  }

  private async start(session: Session): Promise<boolean> {
    const run: Run = { terminalId: null, cancelled: false };
    session.run = run;
    const cols = session.view.cols || DEFAULT_SIZE.cols;
    const rows = session.view.rows || DEFAULT_SIZE.rows;
    const opening = this.ipc.open(session.connectionId, cols, rows, (event) =>
      this.onEvent(session, run, event),
    );
    session.queue = opening.catch(() => undefined);
    try {
      run.terminalId = await opening;
    } catch (err) {
      if (!run.cancelled) {
        session.run = null;
        notifyError(this.alerts, err, 'Terminal not opened');
      }
      return false;
    }
    if (run.cancelled) {
      void this.ipc.close(run.terminalId).catch(() => undefined);
      return false;
    }
    session.sentSize = { cols, rows };
    if (session.run === run) {
      session.state.set('open');
      this.syncSize(session);
    }
    return true;
  }

  private onEvent(session: Session, run: Run, event: TerminalEvent): void {
    if (session.run !== run || session.disposed) {
      return;
    }
    if (event.kind === 'data') {
      session.view.write(event.bytes);
    } else if (event.kind === 'closed') {
      session.run = null;
      session.state.set('ended');
      session.reason.set(event.reason);
    }
  }

  private send(session: Session, data: string): void {
    const run = session.run;
    if (!run || session.state() === 'ended') {
      return;
    }
    this.enqueue(session, run, (terminalId) => this.ipc.write(terminalId, data));
  }

  private syncSize(session: Session): void {
    const run = session.run;
    const { cols, rows } = session.view;
    if (!run?.terminalId || (cols === session.sentSize.cols && rows === session.sentSize.rows)) {
      return;
    }
    session.sentSize = { cols, rows };
    this.enqueue(session, run, (terminalId) => this.ipc.resize(terminalId, cols, rows));
  }

  /** Writes and resizes go through one chain per tab so keystrokes reach the shell in order. */
  private enqueue(session: Session, run: Run, call: (terminalId: string) => Promise<void>): void {
    session.queue = session.queue.then(async () => {
      if (session.run !== run || !run.terminalId) {
        return;
      }
      try {
        await call(run.terminalId);
      } catch (err) {
        if (session.run === run) {
          notifyError(this.alerts, err, 'Terminal input lost');
        }
      }
    });
  }

  private session(tab: TerminalTab): Session | null {
    return (this._tabs()[tab.connectionId] ?? []).find((s) => s.key === tab.key) ?? null;
  }

  private remove(session: Session): void {
    session.disposed = true;
    const tabs = this._tabs()[session.connectionId] ?? [];
    const index = tabs.indexOf(session);
    const rest = tabs.filter((s) => s !== session);
    this._tabs.update((all) => ({ ...all, [session.connectionId]: rest }));
    if (this._active()[session.connectionId] === session.key && rest.length) {
      this.select(rest[Math.min(index, rest.length - 1)]);
    }
    session.element.remove();
    session.view.dispose();
  }
}
