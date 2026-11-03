import { Component, inject, signal } from '@angular/core';
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
import { errorText, notifyError } from '../../project-tree/save-error';
import { KeyActions } from '../key-actions';

@Component({
  imports: [
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
  ],
  selector: 'app-keys-page',
  styleUrl: './keys-page.scss',
  templateUrl: './keys-page.html',
})
export class KeysPage {
  private readonly store = inject(KeyStore);
  private readonly alerts = inject(TuiNotificationService);
  protected readonly actions = inject(KeyActions);

  protected readonly keys = this.store.keys;
  protected readonly loading = signal(true);
  /** Set when the last load failed, so an empty list is not shown as "no keys". */
  protected readonly loadError = signal<string | null>(null);
  protected readonly openMenu = signal<string | null>(null);

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
      notifyError(this.alerts, err, 'Keys unavailable');
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
}
