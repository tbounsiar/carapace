import { Component, computed, effect, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, FormsModule, ReactiveFormsModule } from '@angular/forms';
import {
  TuiDialogService,
  TuiError,
  TuiIcon,
  TuiLabel,
  TuiLink,
  TuiNotification,
  TuiNotificationService,
  TuiSlider,
  TuiTitle,
} from '@taiga-ui/core';
import { TuiSegmented, TuiSwitch } from '@taiga-ui/kit';
import { TuiForm, TuiHeader } from '@taiga-ui/layout';
import { PolymorpheusComponent } from '@taiga-ui/polymorpheus';
import { Analytics } from '../../../core/ipc/analytics';
import type { KeyType } from '../../../core/ipc/keys';
import { FONT_SIZE_MAX, FONT_SIZE_MIN, Settings } from '../../../core/settings/settings';
import type { ThemeMode } from '../../../core/theme/theme';
import { openPrivacyPage, UNSAVED_DENIAL, unsavedDenial } from '../../analytics/privacy-page';
import { notifyError } from '../../project-tree/save-error';

const THEME_OPTIONS: readonly { value: ThemeMode; label: string; icon: string }[] = [
  { value: 'system', label: 'System', icon: '@tui.monitor' },
  { value: 'light', label: 'Light', icon: '@tui.sun' },
  { value: 'dark', label: 'Dark', icon: '@tui.moon' },
];

const KEY_TYPE_OPTIONS: readonly { value: KeyType; label: string }[] = [
  { value: 'ed25519', label: 'Ed25519' },
  { value: 'rsa4096', label: 'RSA 4096' },
];

@Component({
  imports: [
    FormsModule,
    ReactiveFormsModule,
    TuiError,
    TuiForm,
    TuiHeader,
    TuiIcon,
    TuiLabel,
    TuiLink,
    TuiNotification,
    TuiSegmented,
    TuiSlider,
    TuiSwitch,
    TuiTitle,
  ],
  selector: 'app-settings-page',
  styleUrl: './settings-page.scss',
  templateUrl: './settings-page.html',
})
export class SettingsPage {
  private readonly settings = inject(Settings);
  private readonly analytics = inject(Analytics);
  private readonly alerts = inject(TuiNotificationService);
  private readonly dialogs = inject(TuiDialogService);

  protected readonly themeOptions = THEME_OPTIONS;
  protected readonly keyTypeOptions = KEY_TYPE_OPTIONS;
  protected readonly fontSizeMin = FONT_SIZE_MIN;
  protected readonly fontSizeMax = FONT_SIZE_MAX;

  protected readonly theme = this.settings.theme;
  protected readonly keyType = this.settings.defaultKeyType;
  protected readonly fontSize = this.settings.terminalFontSize;

  protected readonly analyticsState = this.analytics.current;
  protected readonly analyticsError = signal(false);
  protected readonly readError = 'Could not read this setting. Restart the app.';
  /** Checked = granted; unset and denied both read as off. */
  protected readonly sharing = new FormControl(
    { value: false, disabled: true },
    { nonNullable: true },
  );
  protected readonly analyticsAvailable = computed(() => this.analyticsState()?.available ?? true);
  protected readonly unsaved = computed(() => unsavedDenial(this.analyticsState()));
  protected readonly unsavedText = UNSAVED_DENIAL;
  /** One save at a time; the switch is not re-synced from the state until the queue drains. */
  private readonly saving = signal(false);
  private wanted: boolean | null = null;

  constructor() {
    this.analytics.state().catch(() => this.analyticsError.set(true));
    effect(() => {
      const state = this.analyticsState();
      if (this.saving()) {
        return;
      }
      if (this.analyticsError() || !state) {
        this.sharing.disable({ emitEvent: false });
        return;
      }
      this.sharing.enable({ emitEvent: false });
      this.sharing.setValue(state.consent === 'granted', { emitEvent: false });
    });
    this.sharing.valueChanges
      .pipe(takeUntilDestroyed())
      .subscribe((granted) => void this.setSharing(granted));
  }

  protected setTheme(mode: ThemeMode): void {
    this.settings.setTheme(mode);
  }

  protected setKeyType(type: KeyType): void {
    this.settings.setDefaultKeyType(type);
  }

  protected setFontSize(size: number | null): void {
    this.settings.setTerminalFontSize(size);
  }

  /** Toggles made while a save is in flight are coalesced: the last choice is saved next. */
  private async setSharing(granted: boolean): Promise<void> {
    this.wanted = granted;
    if (this.saving()) {
      return;
    }
    this.saving.set(true);
    while (this.wanted !== null) {
      const next = this.wanted;
      this.wanted = null;
      try {
        await this.analytics.setConsent(next);
      } catch (err) {
        if (!unsavedDenial(this.analyticsState())) {
          notifyError(this.alerts, err, 'Setting not saved');
        }
      }
    }
    this.saving.set(false);
  }

  protected openPolicy(): void {
    openPrivacyPage(this.analytics, this.alerts);
  }

  protected async showEvents(): Promise<void> {
    const state = this.analyticsState();
    if (!state) {
      return;
    }
    const { AnalyticsEventsDialog } =
      await import('../../analytics/analytics-events-dialog/analytics-events-dialog');
    this.dialogs
      .open(new PolymorpheusComponent(AnalyticsEventsDialog), {
        label: 'Recent usage events',
        size: 'm',
        data: state,
      })
      .subscribe();
  }
}
