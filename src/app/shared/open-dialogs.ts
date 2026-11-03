import { computed, type Provider, Service, signal } from '@angular/core';
import { type TuiDialogOptions, TuiDialogService } from '@taiga-ui/core';
import type { TuiModalComponent } from '@taiga-ui/core/portals/modal';
import type { PolymorpheusComponent } from '@taiga-ui/polymorpheus';

/**
 * `TuiDialogService` that counts its open dialogs. Taiga keeps no public list of them and has no
 * queue, so a prompter that must not stack on another dialog waits for `none()`.
 */
@Service()
export class OpenDialogs extends TuiDialogService {
  private readonly count = signal(0);
  readonly none = computed(() => this.count() === 0);

  protected override add(
    component: PolymorpheusComponent<TuiModalComponent<TuiDialogOptions<unknown>>>,
  ): () => void {
    const close = super.add(component);
    this.count.update((n) => n + 1);
    let closed = false;
    return () => {
      if (!closed) {
        closed = true;
        this.count.update((n) => n - 1);
      }
      close();
    };
  }
}

/** Every `inject(TuiDialogService)`, Taiga's own confirm included, goes through the counter. */
export function provideOpenDialogs(): Provider {
  return { provide: TuiDialogService, useExisting: OpenDialogs };
}
