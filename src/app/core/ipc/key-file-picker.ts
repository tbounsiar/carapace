import { Service, signal } from '@angular/core';
import { IpcError, invokeCommand } from './ipc-error';

/**
 * OS folder and file pickers, opened by the backend. They return a path only; the file itself is
 * never read here. One picker at a time: `picking` disables every Browse button while one is open.
 */
@Service()
export class KeyFilePicker {
  private readonly _picking = signal(false);
  readonly picking = this._picking.asReadonly();

  /** `current` is the start hint; null when the field is empty or holds a template. */
  pickFolder(current: string | null): Promise<string | null> {
    return this.pick('pick_key_folder', current);
  }

  pickFile(current: string | null): Promise<string | null> {
    return this.pick('pick_key_file', current);
  }

  private async pick(command: string, current: string | null): Promise<string | null> {
    if (this._picking()) {
      return null;
    }
    this._picking.set(true);
    try {
      return await invokeCommand<string | null>(command, { current });
    } catch (err) {
      if (err instanceof IpcError && err.code === 'busy') {
        return null;
      }
      throw err;
    } finally {
      this._picking.set(false);
    }
  }
}
