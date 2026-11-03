import { computed, inject, Injector, Service } from '@angular/core';
import { NavigationCancel, NavigationEnd, NavigationError, Router } from '@angular/router';
import { filter, firstValueFrom } from 'rxjs';
import type { Host } from '../../core/ipc/config.models';
import { hostTarget } from '../../core/ipc/connection';
import { SshService } from '../../core/ipc/ssh';
import { connectionTabStatus, terminalTabStatus } from '../workspace/tab-status';
import { tabKey, Workspace, type WorkspaceTab } from '../workspace/workspace';
import { HostConnector } from './host-connector';

/**
 * The single "reach a host" entry point: host page, terminals, files and editor tabs. Callers
 * never touch the workspace or the terminal sessions directly.
 */
@Service()
export class HostLauncher {
  private readonly router = inject(Router);
  private readonly ssh = inject(SshService);
  private readonly connector = inject(HostConnector);
  private readonly workspace = inject(Workspace);
  private readonly injector = inject(Injector);

  /** The host page. Resolves false when the navigation did not happen (e.g. kept by a guard). */
  async open(host: Host): Promise<boolean> {
    const url = this.router.serializeUrl(this.router.createUrlTree(['/hosts', host.id]));
    if (this.router.url === url) {
      return true;
    }
    // A double-click: the first click is already navigating there, possibly held by a guard.
    const pending = this.router.currentNavigation();
    if (pending && this.router.serializeUrl(pending.extractedUrl) === url) {
      await firstValueFrom(
        this.router.events.pipe(
          filter(
            (e) =>
              e instanceof NavigationEnd ||
              e instanceof NavigationCancel ||
              e instanceof NavigationError,
          ),
        ),
      );
      return this.router.url === url;
    }
    return (await this.router.navigate(['/hosts', host.id])) !== false;
  }

  /** Focus or open: the most recent running terminal, else reopen the last ended one, else a new one. */
  async openTerminal(host: Host): Promise<void> {
    const running = this.workspace.mostRecent(host.id, 'terminal', (t) => this.isRunning(t));
    if (running) {
      await this.workspace.activate(running);
      return;
    }
    if (!(await this.open(host)) || !(await this.ensureConnected(host))) {
      return;
    }
    const ended = this.workspace.mostRecent(host.id, 'terminal');
    if (ended?.terminal) {
      await this.workspace.activate(ended);
      const sessions = await this.sessions();
      await sessions.reopen(ended.terminal);
      return;
    }
    await this.addTerminal(host);
  }

  /** Always a new terminal, on the host page unless one of the host's tabs is active. */
  async newTerminal(host: Host): Promise<void> {
    if (this.workspace.active()?.hostId !== host.id && !(await this.open(host))) {
      return;
    }
    if (await this.ensureConnected(host)) {
      await this.addTerminal(host);
    }
  }

  /** Focus or open the host's Files tab; the remote pane offers Connect when needed. */
  async openFiles(host: Host): Promise<void> {
    const key = tabKey('files', host.id);
    const connection = hostTarget(host).connectionId;
    const tab =
      this.workspace.byKey(key) ??
      this.workspace.add({
        key,
        kind: 'files',
        hostId: host.id,
        label: 'Files',
        status: computed(() =>
          connectionTabStatus(this.ssh.stateOf(connection), this.ssh.endReasons()[connection]),
        ),
      });
    await this.workspace.activate(tab);
  }

  /** Focus or open an editor tab on a remote file; `size` comes from the listing. */
  async openFile(host: Host, path: string, size: number | null): Promise<void> {
    // Lazy: the editor documents stay out of the initial bundle; CodeMirror is a further chunk.
    const { EditorDocs } = await import('../editor/editor-docs');
    await this.injector.get(EditorDocs).open(host, path, size);
  }

  private isRunning(tab: WorkspaceTab): boolean {
    return !!tab.terminal && tab.terminal.state() !== 'ended';
  }

  private async ensureConnected(host: Host): Promise<boolean> {
    const target = hostTarget(host);
    if (this.ssh.stateOf(target.connectionId) === 'connected') {
      return true;
    }
    await this.connector.connect(target);
    return this.ssh.stateOf(target.connectionId) === 'connected';
  }

  private async addTerminal(host: Host): Promise<void> {
    const sessions = await this.sessions();
    const connection = hostTarget(host).connectionId;
    const terminal = await sessions.open(connection);
    if (!terminal) {
      return;
    }
    const tab = this.workspace.add({
      key: tabKey('terminal', host.id, terminal.n),
      kind: 'terminal',
      hostId: host.id,
      label: `Terminal ${terminal.n}`,
      terminal,
      status: computed(() =>
        terminalTabStatus(terminal.state(), terminal.reason(), this.ssh.endReasons()[connection]),
      ),
      dispose: () => void sessions.close(terminal),
    });
    await this.workspace.activate(tab);
  }

  // Lazy: terminal sessions pull xterm's loader, which stays out of the initial bundle.
  private async sessions() {
    const { TerminalSessions } = await import('../terminal/terminal-sessions');
    return this.injector.get(TerminalSessions);
  }
}
