import { Service, signal } from '@angular/core';

export type HostView = 'terminal' | 'files';

/** Terminal or Files, remembered per host for the app session. */
@Service()
export class HostViews {
  private readonly views = signal<Readonly<Record<string, HostView>>>({});

  of(hostId: string): HostView {
    return this.views()[hostId] ?? 'terminal';
  }

  set(hostId: string, view: HostView): void {
    this.views.update((views) => ({ ...views, [hostId]: view }));
  }
}
