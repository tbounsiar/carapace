/** Horizontal side of a context menu relative to the pointer (Taiga's `tuiDropdownAlign`). */
export type ContextAlign = 'start' | 'end';

/** Closer than this to the window's right edge, a menu opening rightwards gets squeezed. */
export const CONTEXT_EDGE_REM = 16;

function rootFontSize(): number {
  return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
}

/**
 * `start` puts the menu's left edge at the pointer; near the right edge Taiga would shrink it
 * until the labels wrap, so the menu grows leftwards (`end`) there instead.
 */
export function contextAlign(
  event: { readonly clientX: number },
  viewportWidth = window.innerWidth,
  remPx = rootFontSize(),
): ContextAlign {
  return viewportWidth - event.clientX < CONTEXT_EDGE_REM * remPx ? 'end' : 'start';
}

/** The row a menu is about: the closest `[data-menu-row]` around the event target. */
export function menuRow(event: Event): HTMLElement | null {
  const target = event.target as Element | null;
  return target?.closest?.<HTMLElement>('[data-menu-row]') ?? null;
}

/** Shift+F10 or the ContextMenu key, without Ctrl, Alt or Meta. */
export function isMenuKey(event: KeyboardEvent): boolean {
  if (event.ctrlKey || event.altKey || event.metaKey) {
    return false;
  }
  return (event.key === 'F10' && event.shiftKey) || event.key === 'ContextMenu';
}

export interface ContextPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * Opens the context menu of `element` from the keyboard: Taiga's context dropdown opens at the
 * pointer of a `contextmenu` event, so the event is given `at`, or the bottom-left corner of the
 * element `at`.
 */
export function openContextMenuAt(element: Element, at: Element | ContextPoint = element): void {
  let point: ContextPoint;
  if (at instanceof Element) {
    const rect = at.getBoundingClientRect();
    point = { x: rect.left, y: rect.bottom };
  } else {
    point = at;
  }
  element.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: point.x,
      clientY: point.y,
    }),
  );
}
