import { FileSelection } from './file-selection';

describe('FileSelection focus', () => {
  it('moves the primary within the selection and ignores unselected paths', () => {
    const selection = new FileSelection();
    selection.select('/a');
    selection.toggle('/b');
    selection.focus('/a');
    expect(selection.primary()).toBe('/a');
    expect(selection.paths()).toEqual(['/a', '/b']);
    selection.focus('/c');
    expect(selection.primary()).toBe('/a');
  });
});

describe('FileSelection', () => {
  const order = ['/a', '/b', '/c', '/d'];

  it('replaces on select and toggles independently', () => {
    const s = new FileSelection();
    s.select('/a');
    s.toggle('/c');
    expect(s.paths()).toEqual(['/a', '/c']);
    expect(s.primary()).toBe('/c');
    s.toggle('/a');
    expect(s.paths()).toEqual(['/c']);
    expect(s.count()).toBe(1);
    s.select('/b');
    expect(s.paths()).toEqual(['/b']);
  });

  it('selects ranges from the anchor in display order, both directions', () => {
    const s = new FileSelection();
    s.select('/b');
    s.range(order, '/d');
    expect(s.paths()).toEqual(['/b', '/c', '/d']);
    s.range(order, '/a');
    expect(s.paths()).toEqual(['/a', '/b']);
    expect(s.primary()).toBe('/a');
  });

  it('starts a range at the clicked entry without an anchor', () => {
    const s = new FileSelection();
    s.range(order, '/c');
    expect(s.paths()).toEqual(['/c']);
  });

  it('selects all and keeps the primary when listed', () => {
    const s = new FileSelection();
    s.select('/c');
    s.selectAll(order);
    expect(s.paths()).toEqual(order);
    expect(s.primary()).toBe('/c');
  });

  it('retains listed paths and moves the primary', () => {
    const s = new FileSelection();
    s.select('/a');
    s.toggle('/b');
    s.retain(new Set(['/a']));
    expect(s.paths()).toEqual(['/a']);
    expect(s.primary()).toBe('/a');
    s.clear();
    expect(s.paths()).toEqual([]);
    expect(s.primary()).toBeNull();
  });
});
