import { NgTemplateOutlet } from '@angular/common';
import { Component, inject } from '@angular/core';
import { TuiAppearance, TuiTitle } from '@taiga-ui/core';
import { OptionReason } from './option-reason';

/** Label of an `appOptionReason` option: dimmed title plus its reason, or the bare label. */
@Component({
  imports: [NgTemplateOutlet, TuiAppearance, TuiTitle],
  selector: 'app-option-label',
  styleUrl: './option-label.scss',
  templateUrl: './option-label.html',
})
export class OptionLabel {
  protected readonly option = inject(OptionReason);
}
