import { Component } from '@angular/core';
import { TuiAutoFocus } from '@taiga-ui/cdk';
import { TuiButton, type TuiDialogContext } from '@taiga-ui/core';
import { injectContext } from '@taiga-ui/polymorpheus';

export interface DestructiveConfirmData {
  readonly content: string;
  /** The destructive action, "Delete" or "Discard". */
  readonly yes: string;
  readonly no: string;
}

/**
 * Taiga's `TUI_CONFIRM` layout and button appearances, but with the initial focus on the safe
 * button: `TUI_CONFIRM` always autofocuses its confirming button.
 */
@Component({
  imports: [TuiAutoFocus, TuiButton],
  selector: 'app-destructive-confirm',
  templateUrl: './destructive-confirm.html',
  styleUrl: './destructive-confirm.scss',
})
export class DestructiveConfirm {
  protected readonly context = injectContext<TuiDialogContext<boolean, DestructiveConfirmData>>();
}
