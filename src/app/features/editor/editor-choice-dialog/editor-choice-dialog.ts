import { Component, computed } from '@angular/core';
import { TuiAutoFocus } from '@taiga-ui/cdk';
import { TuiButton, type TuiDialogContext, TuiHint, TuiNotification } from '@taiga-ui/core';
import { injectContext } from '@taiga-ui/polymorpheus';

export type EditorChoiceKind = 'unsaved' | 'changed' | 'deleted' | 'retargeted';
export type EditorChoice = 'save' | 'discard' | 'overwrite' | 'reload' | 'saveAnyway' | 'cancel';

export interface EditorChoiceData {
  readonly kind: EditorChoiceKind;
  readonly name: string;
  readonly host: string;
}

interface ChoiceButton {
  readonly choice: EditorChoice;
  readonly label: string;
  readonly appearance: string;
  readonly testId: string;
  readonly hint?: string;
  readonly focus?: boolean;
}

const BUTTONS: Readonly<Record<EditorChoiceKind, readonly ChoiceButton[]>> = {
  unsaved: [
    { choice: 'cancel', label: 'Cancel', appearance: 'flat', testId: 'unsaved-cancel' },
    {
      choice: 'discard',
      label: "Don't save",
      appearance: 'flat-destructive',
      testId: 'unsaved-discard',
    },
    {
      choice: 'save',
      label: 'Save',
      appearance: 'primary',
      testId: 'unsaved-save',
      focus: true,
    },
  ],
  changed: [
    {
      choice: 'overwrite',
      label: 'Overwrite',
      appearance: 'flat-destructive',
      testId: 'conflict-edit-overwrite',
    },
    {
      choice: 'reload',
      label: 'Reload from server',
      appearance: 'flat-destructive',
      testId: 'conflict-edit-reload',
      hint: 'Discards your changes',
    },
    {
      choice: 'cancel',
      label: 'Cancel',
      appearance: 'primary',
      testId: 'conflict-edit-cancel',
      focus: true,
    },
  ],
  // The backend refuses any save through a link that now points elsewhere, forced or not.
  retargeted: [
    {
      choice: 'reload',
      label: 'Reload from server',
      appearance: 'flat-destructive',
      testId: 'conflict-edit-reload',
      hint: 'Discards your changes',
    },
    {
      choice: 'cancel',
      label: 'Keep editing',
      appearance: 'primary',
      testId: 'conflict-edit-cancel',
      focus: true,
    },
  ],
  deleted: [
    {
      choice: 'saveAnyway',
      label: 'Save anyway',
      appearance: 'flat-destructive',
      testId: 'conflict-edit-save-anyway',
    },
    {
      choice: 'cancel',
      label: 'Cancel',
      appearance: 'primary',
      testId: 'conflict-edit-cancel',
      focus: true,
    },
  ],
};

/** Three-way choices for an editor buffer; Taiga's confirm has two buttons only. */
@Component({
  imports: [TuiAutoFocus, TuiButton, TuiHint, TuiNotification],
  selector: 'app-editor-choice-dialog',
  templateUrl: './editor-choice-dialog.html',
  styleUrl: './editor-choice-dialog.scss',
})
export class EditorChoiceDialog {
  protected readonly context = injectContext<TuiDialogContext<EditorChoice, EditorChoiceData>>();
  protected readonly data = this.context.data;
  protected readonly buttons = computed(() => BUTTONS[this.data.kind]);

  protected choose(choice: EditorChoice): void {
    this.context.completeWith(choice);
  }
}
