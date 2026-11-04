import type { TuiDialogService } from '@taiga-ui/core';
import { PolymorpheusComponent } from '@taiga-ui/polymorpheus';
import { firstValueFrom } from 'rxjs';
import type { DestructiveConfirmData } from './destructive-confirm';

/** Resolves true only when the destructive button was pressed (Esc and close are a no). */
export async function confirmDestructive(
  dialogs: TuiDialogService,
  label: string,
  data: DestructiveConfirmData,
  /** 'm' for a title that would leave one word alone on a second line at 's'. */
  size: 's' | 'm' = 's',
): Promise<boolean> {
  const { DestructiveConfirm } = await import('./destructive-confirm');
  return firstValueFrom(
    dialogs.open<boolean>(new PolymorpheusComponent(DestructiveConfirm), {
      label,
      size,
      data,
    }),
    { defaultValue: false },
  );
}
