import { isTreeKey, treeKeyAction, type VisibleRow } from './tree-keys';

// project(0) > collection(1) > host(2), host(3); project(4, collapsed); project(5, no children)
const ROWS: VisibleRow[] = [
  { parent: -1, expanded: true },
  { parent: 0, expanded: true },
  { parent: 1, expanded: null },
  { parent: 1, expanded: null },
  { parent: -1, expanded: false },
  { parent: -1, expanded: null },
];

describe('treeKeyAction', () => {
  it('moves down and up without wrapping', () => {
    expect(treeKeyAction('ArrowDown', ROWS, 3)).toEqual({ kind: 'focus', index: 4 });
    expect(treeKeyAction('ArrowUp', ROWS, 4)).toEqual({ kind: 'focus', index: 3 });
    expect(treeKeyAction('ArrowDown', ROWS, 5)).toEqual({ kind: 'none' });
    expect(treeKeyAction('ArrowUp', ROWS, 0)).toEqual({ kind: 'none' });
  });

  it('jumps to the first and last rows', () => {
    expect(treeKeyAction('Home', ROWS, 3)).toEqual({ kind: 'focus', index: 0 });
    expect(treeKeyAction('End', ROWS, 1)).toEqual({ kind: 'focus', index: 5 });
    expect(treeKeyAction('Home', ROWS, 0)).toEqual({ kind: 'none' });
  });

  it('expands a collapsed row, then enters its first child', () => {
    expect(treeKeyAction('ArrowRight', ROWS, 4)).toEqual({ kind: 'toggle', index: 4 });
    expect(treeKeyAction('ArrowRight', ROWS, 1)).toEqual({ kind: 'focus', index: 2 });
  });

  it('does nothing on ArrowRight for leaves', () => {
    expect(treeKeyAction('ArrowRight', ROWS, 2)).toEqual({ kind: 'none' });
    expect(treeKeyAction('ArrowRight', ROWS, 5)).toEqual({ kind: 'none' });
  });

  it('collapses an expanded row, otherwise moves to the parent', () => {
    expect(treeKeyAction('ArrowLeft', ROWS, 1)).toEqual({ kind: 'toggle', index: 1 });
    expect(treeKeyAction('ArrowLeft', ROWS, 3)).toEqual({ kind: 'focus', index: 1 });
    expect(treeKeyAction('ArrowLeft', ROWS, 4)).toEqual({ kind: 'none' });
  });

  it('ignores other keys and unknown rows', () => {
    expect(treeKeyAction('Enter', ROWS, 1)).toEqual({ kind: 'none' });
    expect(treeKeyAction('ArrowDown', ROWS, 9)).toEqual({ kind: 'none' });
    expect(isTreeKey('Enter')).toBe(false);
    expect(isTreeKey('End')).toBe(true);
  });
});
