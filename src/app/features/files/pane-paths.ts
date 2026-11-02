import { Service } from '@angular/core';
import type { FileSide } from '../../core/ipc/files';

/** Last listed path of each pane, per connection, for the app session. */
@Service()
export class PanePaths {
  private readonly paths = new Map<string, string>();

  get(connectionId: string, side: FileSide): string | null {
    return this.paths.get(`${side}:${connectionId}`) ?? null;
  }

  set(connectionId: string, side: FileSide, path: string): void {
    this.paths.set(`${side}:${connectionId}`, path);
  }
}
