import { Service, signal } from '@angular/core';
import type { FileSide } from '../../core/ipc/files';

export interface DraggedFiles {
  readonly side: FileSide;
  readonly paths: readonly string[];
}

/**
 * Marks a drag started in a pane. Other apps can read OS drag data, so it carries a placeholder
 * and the paths stay in `FileDrag`.
 */
export const DRAG_TYPE = 'application/x-carapace-files';
export const DRAG_PLACEHOLDER = 'carapace';

/**
 * The entries being dragged between panes. `dataTransfer` contents are unreadable during
 * `dragover`, so drop targets read the source side from here.
 */
@Service()
export class FileDrag {
  private readonly _current = signal<DraggedFiles | null>(null);

  readonly current = this._current.asReadonly();

  start(files: DraggedFiles): void {
    this._current.set(files);
  }

  end(): void {
    this._current.set(null);
  }
}
