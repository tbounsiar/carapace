import { computed, signal } from '@angular/core';

/** Selected entry paths of one pane. Single selection for now: `select` replaces the set. */
export class FileSelection {
  private readonly _paths = signal<readonly string[]>([]);

  readonly paths = this._paths.asReadonly();
  readonly primary = computed(() => this._paths().at(-1) ?? null);

  has(path: string): boolean {
    return this._paths().includes(path);
  }

  select(path: string): void {
    this._paths.set([path]);
  }

  clear(): void {
    this._paths.set([]);
  }

  /** Drops paths that are no longer listed. */
  retain(listed: ReadonlySet<string>): void {
    const kept = this._paths().filter((p) => listed.has(p));
    if (kept.length !== this._paths().length) {
      this._paths.set(kept);
    }
  }
}
