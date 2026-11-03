import { inject, Injector, Service } from '@angular/core';
import { Router } from '@angular/router';
import type { Host } from '../../core/ipc/config.models';
import { hostTarget } from '../../core/ipc/connection';
import { SshService } from '../../core/ipc/ssh';
import { type HostView, HostViews } from '../host-detail/host-view';
import { HostConnector } from './host-connector';

/** Opens a host page on a given view, and the "reach a host" path: open, connect, terminal. */
@Service()
export class HostLauncher {
  private readonly router = inject(Router);
  private readonly views = inject(HostViews);
  private readonly ssh = inject(SshService);
  private readonly connector = inject(HostConnector);
  private readonly injector = inject(Injector);

  /** Resolves false when the navigation did not happen (e.g. kept by an unsaved-changes guard). */
  async open(host: Host, view?: HostView): Promise<boolean> {
    if (view) {
      this.views.set(host.id, view);
    }
    return this.router.navigate(['/hosts', host.id]);
  }

  /** Opens the host on its terminal, connects it if needed, then shows its terminal or a new one. */
  async openTerminal(host: Host): Promise<void> {
    if (!(await this.open(host, 'terminal'))) {
      return;
    }
    const target = hostTarget(host);
    if (this.ssh.stateOf(target.connectionId) !== 'connected') {
      await this.connector.connect(target);
      if (this.ssh.stateOf(target.connectionId) !== 'connected') {
        return;
      }
    }
    // Lazy: terminal sessions pull xterm's loader, which stays out of the initial bundle.
    const { TerminalSessions } = await import('../terminal/terminal-sessions');
    const sessions = this.injector.get(TerminalSessions);
    if (!sessions.tabs(target.connectionId).length) {
      await sessions.open(target.connectionId);
    }
  }
}
