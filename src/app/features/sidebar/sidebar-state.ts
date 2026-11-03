import { Service, signal } from '@angular/core';

const STORAGE_KEY = 'carapace.expanded';

function readStored(): ReadonlySet<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

/** Expanded collections (persisted per id) and the next sidebar item to focus. */
@Service()
export class SidebarState {
  private readonly _expanded = signal<ReadonlySet<string>>(readStored());
  private readonly _focusRequest = signal<string | null>(null);

  readonly expanded = this._expanded.asReadonly();
  /** A node or project id the sidebar focuses (and scrolls to) once it is rendered. */
  readonly focusRequest = this._focusRequest.asReadonly();

  isOpen(collectionId: string): boolean {
    return this._expanded().has(collectionId);
  }

  setOpen(collectionId: string, open: boolean): void {
    if (this.isOpen(collectionId) !== open) {
      this.update((set) => (open ? set.add(collectionId) : set.delete(collectionId)));
    }
  }

  expand(collectionIds: readonly string[]): void {
    if (collectionIds.some((id) => !this.isOpen(id))) {
      this.update((set) => collectionIds.forEach((id) => set.add(id)));
    }
  }

  focus(id: string): void {
    this._focusRequest.set(id);
  }

  focusDone(): void {
    this._focusRequest.set(null);
  }

  private update(change: (set: Set<string>) => unknown): void {
    const next = new Set(this._expanded());
    change(next);
    this._expanded.set(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
    } catch {
      // Expanded state then lasts for the session only.
    }
  }
}
