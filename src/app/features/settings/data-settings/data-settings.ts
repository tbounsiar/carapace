import { Component, computed, inject } from '@angular/core';
import { TuiButton } from '@taiga-ui/core';
import { TuiButtonLoading } from '@taiga-ui/kit';
import { ConfigService } from '../../../core/ipc/config';
import { KeyStore } from '../../../core/ipc/key-store';
import { DataTransferActions } from '../../data-transfer/data-transfer-actions';

/** The "Data" group of the Settings page: export and import entry points. */
@Component({
  imports: [TuiButton, TuiButtonLoading],
  selector: 'app-data-settings',
  templateUrl: './data-settings.html',
  styleUrl: './data-settings.scss',
})
export class DataSettings {
  private readonly config = inject(ConfigService);
  private readonly keys = inject(KeyStore);
  private readonly actions = inject(DataTransferActions);

  protected readonly loading = computed(() => !this.config.loaded() || this.config.loading());
  protected readonly importing = this.actions.importing;
  protected readonly nothingToExport = computed(
    () =>
      !this.loading() &&
      !this.config.variables().length &&
      !this.config.projects().length &&
      !this.config.nodes().length &&
      !this.keys.keys().length,
  );

  constructor() {
    this.keys.ensureLoaded().catch(() => undefined);
  }

  protected exportData(): void {
    void this.actions.exportData();
  }

  protected importData(): void {
    void this.actions.importData();
  }
}
