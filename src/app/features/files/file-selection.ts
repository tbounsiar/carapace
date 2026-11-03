import { computed, signal } from '@angular/core';

/**
 * Selected entry paths of one pane. `primary` is the last clicked or moved-to entry (focus and
 * keyboard start there); `anchor` is where a Shift range starts.
 */
export class FileSelection {
  private readonly _paths = signal<readonly string[]>([]);
  private readonly _primary = signal<string | null>(null);
  private anchor: string | null = null;

  readonly paths = this._paths.asReadonly();
  readonly primary = this._primary.asReadonly();
  readonly count = computed(() => this._paths().length);

  has(path: string): boolean {
    return this._paths().includes(path);
  }

  select(path: string): void {
    this._paths.set([path]);
    this._primary.set(path);
    this.anchor = path;
  }

  toggle(path: string): void {
    const paths = this._paths();
    this._paths.set(paths.includes(path) ? paths.filter((p) => p !== path) : [...paths, path]);
    this._primary.set(path);
    this.anchor = path;
  }

  /** Selects from the anchor to `path` in the given (displayed) order; the anchor stays. */
  range(ordered: readonly string[], path: string): void {
    const to = ordered.indexOf(path);
    const from = this.anchor === null ? -1 : ordered.indexOf(this.anchor);
    if (to < 0 || from < 0) {
      this.select(path);
      return;
    }
    const [start, end] = from <= to ? [from, to] : [to, from];
    this._paths.set(ordered.slice(start, end + 1));
    this._primary.set(path);
  }

  selectAll(ordered: readonly string[]): void {
    this._paths.set([...ordered]);
    if (this._primary() === null || !ordered.includes(this._primary()!)) {
      this._primary.set(ordered[0] ?? null);
    }
    this.anchor = this._primary();
  }

  clear(): void {
    this._paths.set([]);
    this._primary.set(null);
    this.anchor = null;
  }

  /** Drops paths that are no longer listed. */
  retain(listed: ReadonlySet<string>): void {
    const kept = this._paths().filter((p) => listed.has(p));
    if (kept.length !== this._paths().length) {
      this._paths.set(kept);
    }
    const primary = this._primary();
    if (primary !== null && !listed.has(primary)) {
      this._primary.set(kept.at(-1) ?? null);
    }
    if (this.anchor !== null && !listed.has(this.anchor)) {
      this.anchor = this._primary();
    }
  }
}
