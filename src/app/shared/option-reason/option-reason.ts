import { DestroyRef, Directive, ElementRef, inject, input } from '@angular/core';

/**
 * A menu option that is unavailable for a reason the user must be able to read. It stays focusable
 * and enabled for the browser (a disabled option is dimmed as a whole, reason included, and never
 * shows a hint), is announced as disabled, and ignores clicks and Enter. `app-option-label` inside
 * it shows the label dimmed and the reason at full contrast.
 */
@Directive({
  selector: '[tuiOption][appOptionReason]',
  host: { '[attr.aria-disabled]': 'appOptionReason() ? "true" : null' },
})
export class OptionReason {
  readonly appOptionReason = input<string | null | undefined>(null);

  constructor() {
    const element = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    // Capture on the element runs before the click bindings of the template.
    const block = (event: Event) => {
      if (this.appOptionReason()) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    element.addEventListener('click', block, { capture: true });
    inject(DestroyRef).onDestroy(() => element.removeEventListener('click', block, true));
  }
}
