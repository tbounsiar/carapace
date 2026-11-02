import { Service } from '@angular/core';
import type { FileSide } from '../../core/ipc/files';

/** Last listed path of each pane, per host, for the app session. */
@Service()
export class PanePaths {
  private readonly paths = new Map<string, string>();

  get(hostId: string, side: FileSide): string | null {
    return this.paths.get(`${side}:${hostId}`) ?? null;
  }

  set(hostId: string, side: FileSide, path: string): void {
    this.paths.set(`${side}:${hostId}`, path);
  }
}
