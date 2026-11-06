import { contextAlign, isMenuKey, menuRow, openContextMenuAt } from './context-menu';

describe('contextAlign', () => {
  it('opens rightwards by default', () => {
    expect(contextAlign({ clientX: 100 }, 1280, 16)).toBe('start');
    expect(contextAlign({ clientX: 1280 - 256 }, 1280, 16)).toBe('start');
  });

  it('opens leftwards within 16rem of the right edge', () => {
    expect(contextAlign({ clientX: 1280 - 255 }, 1280, 16)).toBe('end');
    expect(contextAlign({ clientX: 790 }, 800, 16)).toBe('end');
    expect(contextAlign({ clientX: 1280 - 300 }, 1280, 20)).toBe('end');
  });
});

describe('menuRow', () => {
  it('finds the closest [data-menu-row]', () => {
    const row = document.createElement('tr');
    row.dataset['menuRow'] = 'a';
    const cell = row.appendChild(document.createElement('td'));
    expect(menuRow({ target: cell } as unknown as Event)).toBe(row);
    expect(menuRow({ target: document.body } as unknown as Event)).toBeNull();
    expect(menuRow({ target: null } as unknown as Event)).toBeNull();
  });
});

describe('isMenuKey', () => {
  const key = (init: KeyboardEventInit): boolean => isMenuKey(new KeyboardEvent('keydown', init));

  it('accepts Shift+F10 and ContextMenu only', () => {
    expect(key({ key: 'F10', shiftKey: true })).toBe(true);
    expect(key({ key: 'ContextMenu' })).toBe(true);
    expect(key({ key: 'F10' })).toBe(false);
    expect(key({ key: 'F10', shiftKey: true, ctrlKey: true })).toBe(false);
    expect(key({ key: 'ContextMenu', altKey: true })).toBe(false);
  });
});

describe('openContextMenuAt', () => {
  it('dispatches a contextmenu at the bottom-left corner of the anchor', () => {
    const element = document.createElement('div');
    const anchor = document.createElement('button');
    anchor.getBoundingClientRect = () => ({ left: 12, bottom: 40 }) as DOMRect;
    const events: MouseEvent[] = [];
    element.addEventListener('contextmenu', (e) => events.push(e));
    openContextMenuAt(element, anchor);
    expect(events.length).toBe(1);
    expect([events[0].clientX, events[0].clientY]).toEqual([12, 40]);
    expect(events[0].cancelable).toBe(true);
  });
});
