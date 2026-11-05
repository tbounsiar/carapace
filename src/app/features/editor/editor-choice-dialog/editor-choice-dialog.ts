import { Component, computed } from '@angular/core';
import { TuiAutoFocus } from '@taiga-ui/cdk';
import {
  TuiButton,
  type TuiDialogContext,
  TuiHint,
  TuiNotification,
  TuiTitle,
} from '@taiga-ui/core';
import { injectContext } from '@taiga-ui/polymorpheus';
import { TranslocoPipe } from '@jsverse/transloco';

/** The `external*` kinds are a file open in an external editor (spec X3). */
export type EditorChoiceKind =
  'unsaved' | 'changed' | 'deleted' | 'retargeted' | 'externalChanged' | 'externalDeleted';
export type EditorChoice =
  'save' | 'discard' | 'overwrite' | 'reload' | 'saveAnyway' | 'useServer' | 'stop' | 'cancel';

export interface EditorChoiceData {
  readonly kind: EditorChoiceKind;
  readonly name: string;
  readonly host: string;
}

interface ChoiceButton {
  readonly choice: EditorChoice;
  /** Translation keys. */
  readonly label: string;
  readonly appearance: string;
  readonly testId: string;
  readonly hint?: string;
  readonly focus?: boolean;
}

const BUTTONS: Readonly<Record<EditorChoiceKind, readonly ChoiceButton[]>> = {
  unsaved: [
    { choice: 'cancel', label: 'common.cancel', appearance: 'flat', testId: 'unsaved-cancel' },
    {
      choice: 'discard',
      label: 'editor.choice.dontSave',
      appearance: 'flat-destructive',
      testId: 'unsaved-discard',
    },
    {
      choice: 'save',
      label: 'common.save',
      appearance: 'primary',
      testId: 'unsaved-save',
      focus: true,
    },
  ],
  changed: [
    {
      choice: 'overwrite',
      label: 'editor.choice.overwrite',
      appearance: 'flat-destructive',
      testId: 'conflict-edit-overwrite',
    },
    {
      choice: 'reload',
      label: 'editor.choice.reload',
      appearance: 'flat-destructive',
      testId: 'conflict-edit-reload',
      hint: 'editor.choice.reloadHint',
    },
    {
      choice: 'cancel',
      label: 'common.cancel',
      appearance: 'primary',
      testId: 'conflict-edit-cancel',
      focus: true,
    },
  ],
  // The backend refuses any save through a link that now points elsewhere, forced or not.
  retargeted: [
    {
      choice: 'reload',
      label: 'editor.choice.reload',
      appearance: 'flat-destructive',
      testId: 'conflict-edit-reload',
      hint: 'editor.choice.reloadHint',
    },
    {
      choice: 'cancel',
      label: 'editor.choice.keepEditing',
      appearance: 'primary',
      testId: 'conflict-edit-cancel',
      focus: true,
    },
  ],
  deleted: [
    {
      choice: 'saveAnyway',
      label: 'editor.choice.saveAnyway',
      appearance: 'flat-destructive',
      testId: 'conflict-edit-save-anyway',
    },
    {
      choice: 'cancel',
      label: 'common.cancel',
      appearance: 'primary',
      testId: 'conflict-edit-cancel',
      focus: true,
    },
  ],
  externalChanged: [
    {
      choice: 'overwrite',
      label: 'editor.choice.overwriteServer',
      appearance: 'flat-destructive',
      testId: 'conflict-ext-overwrite',
    },
    {
      choice: 'useServer',
      label: 'editor.choice.useServer',
      appearance: 'flat-destructive',
      testId: 'conflict-ext-server',
      hint: 'editor.choice.useServerHint',
    },
    {
      choice: 'cancel',
      label: 'editor.choice.keepMine',
      appearance: 'primary',
      testId: 'conflict-ext-keep',
      focus: true,
    },
  ],
  externalDeleted: [
    {
      choice: 'overwrite',
      label: 'editor.choice.uploadAnyway',
      appearance: 'flat-destructive',
      testId: 'conflict-ext-upload-anyway',
    },
    {
      choice: 'stop',
      label: 'editor.choice.stopEditing',
      appearance: 'flat-destructive',
      testId: 'conflict-ext-stop',
    },
    {
      choice: 'cancel',
      label: 'editor.choice.keepMine',
      appearance: 'primary',
      testId: 'conflict-ext-keep',
      focus: true,
    },
  ],
};

/** Three-way choices for an editor buffer; Taiga's confirm has two buttons only. */
@Component({
  imports: [TranslocoPipe, TuiAutoFocus, TuiButton, TuiHint, TuiNotification, TuiTitle],
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
