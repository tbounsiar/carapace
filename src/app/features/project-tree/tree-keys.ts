export interface VisibleRow {
  /** Index of the parent row in the same list, or -1 for a root row. */
  readonly parent: number;
  /** `null` when the row has no children to show. */
  readonly expanded: boolean | null;
}

export type TreeKeyAction =
  | { readonly kind: 'focus'; readonly index: number }
  | { readonly kind: 'toggle'; readonly index: number }
  | { readonly kind: 'none' };

const TREE_KEYS = new Set(['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End']);

export function isTreeKey(key: string): boolean {
  return TREE_KEYS.has(key);
}

export function treeKeyAction(
  key: string,
  rows: readonly VisibleRow[],
  current: number,
): TreeKeyAction {
  const row = rows[current];
  const none: TreeKeyAction = { kind: 'none' };
  if (!row) {
    return none;
  }
  const focus = (index: number): TreeKeyAction =>
    index >= 0 && index < rows.length && index !== current ? { kind: 'focus', index } : none;

  switch (key) {
    case 'ArrowDown':
      return focus(current + 1);
    case 'ArrowUp':
      return focus(current - 1);
    case 'Home':
      return focus(0);
    case 'End':
      return focus(rows.length - 1);
    case 'ArrowRight':
      if (row.expanded === false) {
        return { kind: 'toggle', index: current };
      }
      return row.expanded && rows[current + 1]?.parent === current ? focus(current + 1) : none;
    case 'ArrowLeft':
      return row.expanded ? { kind: 'toggle', index: current } : focus(row.parent);
    default:
      return none;
  }
}
