import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { TuiTable } from '@taiga-ui/addon-table';
import {
  TuiButton,
  TuiDataList,
  TuiDropdown,
  TuiHint,
  TuiIcon,
  TuiLoader,
  TuiNotificationService,
  TuiTitle,
} from '@taiga-ui/core';
import { TuiAvatar, TuiBadge } from '@taiga-ui/kit';
import { TuiBlockStatus, TuiHeader } from '@taiga-ui/layout';
import { KeyStore } from '../../../core/ipc/key-store';
import { keyTypeLabel, type KeyView } from '../../../core/ipc/keys';
import { textOf } from '../../../shared/backend-text';
import { isMenuKey } from '../../../shared/context-menu/context-menu';
import { ContextMenuTarget } from '../../../shared/context-menu/context-menu-target';
import { errorText, notifyError } from '../../../shared/save-error';
import { KeyActions } from '../key-actions';

@Component({
  imports: [
    ContextMenuTarget,
    NgTemplateOutlet,
    TuiAvatar,
    TuiBadge,
    TuiBlockStatus,
    TuiButton,
    TuiDataList,
    TuiDropdown,
    TuiHeader,
    TuiHint,
    TuiIcon,
    TuiLoader,
    TuiTable,
    TuiTitle,
    TranslocoPipe,
  ],
  selector: 'app-keys-page',
  styleUrl: './keys-page.scss',
  templateUrl: './keys-page.html',
})
export class KeysPage {
  private readonly store = inject(KeyStore);
  private readonly alerts = inject(TuiNotificationService);
  private readonly transloco = inject(TranslocoService);
  protected readonly actions = inject(KeyActions);

  protected readonly keys = this.store.keys;
  protected readonly text = textOf;
  protected readonly loading = signal(true);
  /** Set when the last load failed, so an empty list is not shown as "no keys". */
  protected readonly loadError = signal<string | null>(null);
  protected readonly openMenu = signal<string | null>(null);
  private readonly contextKeyId = signal<string | null>(null);
  /** The key whose context menu opened last. */
  protected readonly contextKey = computed(
    () => this.keys().find((k) => k.id === this.contextKeyId()) ?? null,
  );

  constructor() {
    void this.reload();
  }

  protected async reload(): Promise<void> {
    this.loading.set(true);
    this.loadError.set(null);
    try {
      await this.store.load();
    } catch (err) {
      this.loadError.set(errorText(err));
      notifyError(this.alerts, err, this.transloco.translate('keys.page.unavailable'));
    } finally {
      this.loading.set(false);
    }
  }

  protected typeLabel(key: KeyView): string {
    return keyTypeLabel(key);
  }

  protected setMenu(key: KeyView, open: boolean): void {
    this.openMenu.update((current) => (open ? key.id : current === key.id ? null : current));
  }

  protected onContextTarget(row: HTMLElement | null): void {
    this.openMenu.set(null);
    this.contextKeyId.set(row?.dataset['menuRow'] ?? null);
  }

  /** Shift+F10 / ContextMenu on any control of a row opens the row's "…" menu. */
  protected onRowKeydown(event: KeyboardEvent, key: KeyView): void {
    if (isMenuKey(event)) {
      event.preventDefault();
      this.openMenu.set(key.id);
    }
  }
}
