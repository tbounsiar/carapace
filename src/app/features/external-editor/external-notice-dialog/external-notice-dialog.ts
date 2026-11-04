import { Component } from '@angular/core';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { TuiAutoFocus } from '@taiga-ui/cdk';
import { TuiButton, TuiCheckbox, type TuiDialogContext, TuiLabel } from '@taiga-ui/core';
import { injectContext } from '@taiga-ui/polymorpheus';

/** Continue answers whether the notice should stop showing; Cancel and Esc answer nothing. */
export interface ExternalNoticeAnswer {
  readonly dontShow: boolean;
}

/** One-time notice before a remote file is first copied to this computer (spec X1, R4). */
@Component({
  imports: [ReactiveFormsModule, TuiAutoFocus, TuiButton, TuiCheckbox, TuiLabel],
  selector: 'app-external-notice-dialog',
  styleUrl: './external-notice-dialog.scss',
  templateUrl: './external-notice-dialog.html',
})
export class ExternalNoticeDialog {
  protected readonly context = injectContext<TuiDialogContext<ExternalNoticeAnswer, void>>();
  protected readonly dontShow = new FormControl(false, { nonNullable: true });

  protected continue(): void {
    this.context.completeWith({ dontShow: this.dontShow.value });
  }
}
