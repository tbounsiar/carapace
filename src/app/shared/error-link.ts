import { afterNextRender, DestroyRef, Directive, ElementRef, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NgControl } from '@angular/forms';

let nextId = 0;

/**
 * Put on a `tui-error[formControlName]`: Taiga renders the message but does not tie it to the
 * field, so screen readers would not read it with the input. Links the input of the same control
 * name in the form with `aria-describedby` and keeps its `aria-invalid` in sync.
 */
@Directive({
  selector: 'tui-error[appErrorLink]',
})
export class ErrorLink {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly ngControl = inject(NgControl, { self: true });
  private input: HTMLElement | null = null;

  constructor() {
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      this.host.id ||= `app-error-${++nextId}`;
      this.input = this.findInput();
      if (!this.input) {
        return;
      }
      const ids = (this.input.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
      if (!ids.includes(this.host.id)) {
        this.input.setAttribute('aria-describedby', [...ids, this.host.id].join(' '));
      }
      this.sync();
      this.ngControl.control?.events.pipe(takeUntilDestroyed(destroyRef)).subscribe(() => {
        this.sync();
      });
    });
  }

  private findInput(): HTMLElement | null {
    const name = this.ngControl.name;
    const scope = this.host.closest('form') ?? this.host.parentElement;
    if (name === null || !scope) {
      return null;
    }
    const selector = `[formcontrolname="${String(name)}"]`;
    return (
      Array.from(scope.querySelectorAll<HTMLElement>(selector)).find(
        (el) => el !== this.host && el.matches('input, textarea, select'),
      ) ?? null
    );
  }

  private sync(): void {
    const control = this.ngControl.control;
    const invalid = !!control && control.invalid && control.touched;
    if (invalid) {
      this.input?.setAttribute('aria-invalid', 'true');
    } else {
      this.input?.removeAttribute('aria-invalid');
    }
  }
}
