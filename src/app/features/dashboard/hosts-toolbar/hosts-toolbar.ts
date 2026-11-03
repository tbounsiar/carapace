import { Component, ElementRef, input, model, output, viewChild } from '@angular/core';
import { TuiInput, TuiTextfield } from '@taiga-ui/core';
import { TuiSegmented } from '@taiga-ui/kit';
import { TuiSearch } from '@taiga-ui/layout';

let toolbars = 0;

/** Dashboard search and the All / Connected switch, with the "5 of 12 hosts" count while filtering. */
@Component({
  imports: [TuiInput, TuiSearch, TuiSegmented, TuiTextfield],
  selector: 'app-hosts-toolbar',
  styleUrl: './hosts-toolbar.scss',
  templateUrl: './hosts-toolbar.html',
  host: { '(window:keydown)': 'onWindowKeydown($event)' },
})
export class HostsToolbar {
  readonly query = model('');
  readonly connectedOnly = model(false);
  readonly placeholder = input('Search hosts');
  /** Shown only while a search or the Connected switch is active. */
  readonly count = input<string | null>(null);
  /** Enter in the search. */
  readonly submitted = output();

  private readonly field = viewChild.required<ElementRef<HTMLInputElement>>('field');
  protected readonly name = `hosts-filter-${++toolbars}`;

  focus(): void {
    this.field().nativeElement.focus();
  }

  protected onInput(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      this.submitted.emit();
    } else if (event.key === 'Escape' && this.query()) {
      event.preventDefault();
      this.query.set('');
    }
  }

  /** The dashboards hold no terminal, so Ctrl+F can take the search here. */
  protected onWindowKeydown(event: KeyboardEvent): void {
    const ctrl = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey;
    if (ctrl && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      this.focus();
    }
  }
}
