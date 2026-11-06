import { DestroyRef, Directive, ElementRef, inject, input, output, signal } from '@angular/core';
import { type ContextAlign, contextAlign, menuRow } from './context-menu';

/**
 * Goes next to `tuiDropdownContext` on a list wrapper (one menu for all its rows). Before Taiga
 * opens the menu it reports the row under the pointer and picks the side the menu grows to; bind
 * `[tuiDropdownAlign]` to `align()`. With `appContextMenuTarget="rows"`, a right click outside any
 * `[data-menu-row]` opens nothing (no app menu, no page menu).
 */
@Directive({
  selector: '[appContextMenuTarget]',
  exportAs: 'appContextMenuTarget',
})
export class ContextMenuTarget {
  readonly appContextMenuTarget = input<'rows' | ''>('');
  /** The row the menu is about, null outside the rows. */
  readonly contextTarget = output<HTMLElement | null>();
  readonly align = signal<ContextAlign>('start');

  constructor() {
    const element = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    // Capture on the element runs before Taiga's bubble listener, which opens the menu.
    const listener = (event: MouseEvent) => {
      const row = menuRow(event);
      if (!row && this.appContextMenuTarget() === 'rows') {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      this.align.set(contextAlign(event));
      this.contextTarget.emit(row);
    };
    element.addEventListener('contextmenu', listener, { capture: true });
    inject(DestroyRef).onDestroy(() =>
      element.removeEventListener('contextmenu', listener, { capture: true }),
    );
  }
}
