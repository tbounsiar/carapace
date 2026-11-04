import { Component } from '@angular/core';
import { TuiAutoFocus } from '@taiga-ui/cdk';
import { TuiButton, type TuiDialogContext, TuiNotification } from '@taiga-ui/core';
import { injectContext } from '@taiga-ui/polymorpheus';

export interface DestructiveConfirmData {
  readonly content: string;
  /** The destructive action, "Delete" or "Discard". */
  readonly yes: string;
  readonly no: string;
  /** `primary` for a confirm that loses nothing; `primary-destructive` by default. */
  readonly appearance?: string;
  readonly yesTestId?: string;
  /** Shows the content as a warning notification. */
  readonly warning?: boolean;
  /** Focuses the confirming button instead of the safe one. */
  readonly focusYes?: boolean;
}

/**
 * Taiga's `TUI_CONFIRM` layout and button appearances, but with the initial focus on the safe
 * button: `TUI_CONFIRM` always autofocuses its confirming button.
 */
@Component({
  imports: [TuiAutoFocus, TuiButton, TuiNotification],
  selector: 'app-destructive-confirm',
  templateUrl: './destructive-confirm.html',
  styleUrl: './destructive-confirm.scss',
})
export class DestructiveConfirm {
  protected readonly context = injectContext<TuiDialogContext<boolean, DestructiveConfirmData>>();
}
