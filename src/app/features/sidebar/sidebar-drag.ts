import { Service, signal } from '@angular/core';

/** Custom type only; the value is a fixed placeholder so no id or name reaches OS drag data. */
export const SIDEBAR_DRAG_TYPE = 'application/x-carapace-node';
export const SIDEBAR_DRAG_PLACEHOLDER = 'carapace-node';

/** The node being dragged in the sidebar; `dataTransfer` cannot be read during dragover. */
@Service()
export class SidebarDrag {
  private readonly _nodeId = signal<string | null>(null);

  readonly nodeId = this._nodeId.asReadonly();

  start(nodeId: string): void {
    this._nodeId.set(nodeId);
  }

  end(): void {
    this._nodeId.set(null);
  }
}
