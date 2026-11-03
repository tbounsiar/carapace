import type { TuiDialogService } from '@taiga-ui/core';
import { PolymorpheusComponent } from '@taiga-ui/polymorpheus';
import { firstValueFrom } from 'rxjs';
import type { EditorChoice, EditorChoiceData } from './editor-choice-dialog/editor-choice-dialog';

const LABELS = {
  unsaved: (name: string) => `Save changes to ${name}?`,
  changed: () => 'File changed on the server',
  deleted: () => 'File changed on the server',
  retargeted: () => 'Link changed on the server',
} as const;

/** Esc and the close button answer Cancel. */
export async function askEditorChoice(
  dialogs: TuiDialogService,
  data: EditorChoiceData,
): Promise<EditorChoice> {
  const { EditorChoiceDialog } = await import('./editor-choice-dialog/editor-choice-dialog');
  return firstValueFrom(
    dialogs.open<EditorChoice>(new PolymorpheusComponent(EditorChoiceDialog), {
      label: LABELS[data.kind](data.name),
      size: 's',
      data,
    }),
    { defaultValue: 'cancel' as EditorChoice },
  );
}
