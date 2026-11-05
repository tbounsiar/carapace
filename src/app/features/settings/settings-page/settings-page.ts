import { Component, computed, effect, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
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
import {
  ANALYTICS_CATEGORIES,
  Analytics,
  type AnalyticsCategory,
} from '../../../core/ipc/analytics';
import {
  type AppLanguage,
  LANGUAGE_NAMES,
  type LanguagePreference,
  LanguageService,
} from '../../../core/i18n/language';
import type { KeyType } from '../../../core/ipc/keys';
import { FONT_SIZE_MAX, FONT_SIZE_MIN, Settings } from '../../../core/settings/settings';
import type { ThemeMode } from '../../../core/theme/theme';
import {
  CATEGORY_COPY,
  COMMON_LEAD,
  COMMON_TEXT,
  NEVER_LEAD,
  NEVER_TEXT,
  openPrivacyPage,
  UNSAVED_DENIAL,
  unsavedDenial,
} from '../../analytics/privacy-page';
import { notifyError } from '../../../shared/save-error';
import { DataSettings } from '../data-settings/data-settings';
import { ExternalEditorSettings } from '../external-editor-settings/external-editor-settings';

const THEME_OPTIONS: readonly { value: ThemeMode; label: string; icon: string }[] = [
  { value: 'system', label: 'settings.theme.system', icon: '@tui.monitor' },
  { value: 'light', label: 'settings.theme.light', icon: '@tui.sun' },
  { value: 'dark', label: 'settings.theme.dark', icon: '@tui.moon' },
];

const LANGUAGE_VALUES: readonly LanguagePreference[] = ['system', 'en', 'fr'];

const KEY_TYPE_OPTIONS: readonly { value: KeyType; label: string }[] = [
  { value: 'ed25519', label: 'Ed25519' },
  { value: 'rsa4096', label: 'RSA 4096' },
];

@Component({
  imports: [
    DataSettings,
    ExternalEditorSettings,
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
    TranslocoPipe,
  ],
  selector: 'app-settings-page',
  styleUrl: './settings-page.scss',
  templateUrl: './settings-page.html',
})
export class SettingsPage {
  private readonly settings = inject(Settings);
  private readonly language = inject(LanguageService);
  private readonly analytics = inject(Analytics);
  private readonly alerts = inject(TuiNotificationService);
  private readonly dialogs = inject(TuiDialogService);
  private readonly transloco = inject(TranslocoService);

  protected readonly themeOptions = THEME_OPTIONS;
  protected readonly keyTypeOptions = KEY_TYPE_OPTIONS;
  /** `lang` of each option: English and Français in their own language, System in the UI's. */
  protected readonly languageOptions = computed(() =>
    LANGUAGE_VALUES.map((value) => ({
      value,
      lang: (value === 'system' ? this.language.active() : value) satisfies AppLanguage,
      name: value === 'system' ? null : LANGUAGE_NAMES[value],
    })),
  );
  protected readonly systemLanguageName = computed(() => LANGUAGE_NAMES[this.language.system()]);
  protected readonly fontSizeMin = FONT_SIZE_MIN;
  protected readonly fontSizeMax = FONT_SIZE_MAX;

  protected readonly fontSize = this.settings.terminalFontSize;
  /**
   * Controls rather than `[ngModel]`: a save that fails before change detection runs reverts the
   * signal to the value the binding already holds, and the input would keep showing the click.
   */
  protected readonly themeControl = new FormControl<ThemeMode>(this.settings.theme(), {
    nonNullable: true,
  });
  protected readonly languageControl = new FormControl<LanguagePreference>(
    this.settings.language(),
    { nonNullable: true },
  );
  protected readonly keyTypeControl = new FormControl<KeyType>(this.settings.defaultKeyType(), {
    nonNullable: true,
  });
  protected readonly fontSizeControl = new FormControl<number>(this.fontSize(), {
    nonNullable: true,
  });
  protected readonly themeIndex = signal(0);
  protected readonly languageIndex = signal(0);
  protected readonly keyTypeIndex = signal(0);

  protected readonly analyticsState = this.analytics.current;
  protected readonly analyticsError = signal(false);
  protected readonly categories = CATEGORY_COPY;
  protected readonly commonLead = COMMON_LEAD;
  protected readonly commonText = COMMON_TEXT;
  protected readonly neverLead = NEVER_LEAD;
  protected readonly neverText = NEVER_TEXT;
  /** Checked = granted and current; unset, outdated and denied all read as off. */
  protected readonly controls = Object.fromEntries(
    ANALYTICS_CATEGORIES.map((category) => [
      category,
      new FormControl({ value: false, disabled: true }, { nonNullable: true }),
    ]),
  ) as Record<AnalyticsCategory, FormControl<boolean>>;
  protected readonly analyticsAvailable = computed(() => this.analyticsState()?.available ?? true);
  protected readonly doNotTrack = computed(() => this.analyticsState()?.doNotTrack ?? false);
  protected readonly unsaved = computed(() => unsavedDenial(this.analyticsState()));
  protected readonly unsavedText = UNSAVED_DENIAL;
  protected readonly describedBy = computed(() => {
    const error = this.analyticsError();
    const dnt = this.doNotTrack();
    const ids = {} as Record<AnalyticsCategory, string>;
    for (const category of ANALYTICS_CATEGORIES) {
      ids[category] = error
        ? 'settings-analytics-error'
        : [`settings-analytics-${category}-note`, 'settings-analytics-common']
            .concat(dnt ? ['settings-analytics-dnt'] : [])
            .join(' ');
    }
    return ids;
  });
  /** One save at a time; the switches are not re-synced from the state until the queue drains. */
  private readonly saving = signal(false);
  private readonly wanted = new Map<AnalyticsCategory, boolean>();

  constructor() {
    effect(() => {
      const theme = this.settings.theme();
      this.themeControl.setValue(theme, { emitEvent: false });
      this.themeIndex.set(THEME_OPTIONS.findIndex((o) => o.value === theme));
    });
    effect(() => {
      const language = this.settings.language();
      this.languageControl.setValue(language, { emitEvent: false });
      this.languageIndex.set(LANGUAGE_VALUES.indexOf(language));
    });
    effect(() => {
      const type = this.settings.defaultKeyType();
      this.keyTypeControl.setValue(type, { emitEvent: false });
      this.keyTypeIndex.set(KEY_TYPE_OPTIONS.findIndex((o) => o.value === type));
    });
    effect(() => this.fontSizeControl.setValue(this.fontSize(), { emitEvent: false }));
    this.themeControl.valueChanges
      .pipe(takeUntilDestroyed())
      .subscribe((mode) => this.settings.setTheme(mode));
    this.languageControl.valueChanges
      .pipe(takeUntilDestroyed())
      .subscribe((language) => this.settings.setLanguage(language));
    this.keyTypeControl.valueChanges
      .pipe(takeUntilDestroyed())
      .subscribe((type) => this.settings.setDefaultKeyType(type));
    this.fontSizeControl.valueChanges
      .pipe(takeUntilDestroyed())
      .subscribe((size) => this.settings.setTerminalFontSize(size));
    this.analytics.state().catch(() => this.analyticsError.set(true));
    effect(() => {
      const state = this.analyticsState();
      if (this.saving()) {
        return;
      }
      const usable = !this.analyticsError() && state !== null && !state.doNotTrack;
      for (const category of ANALYTICS_CATEGORIES) {
        const control = this.controls[category];
        if (usable) {
          control.enable({ emitEvent: false });
          control.setValue(state.categories[category], { emitEvent: false });
        } else {
          // Under DO_NOT_TRACK the switches show what happens (off), not what is stored.
          control.disable({ emitEvent: false });
          if (state?.doNotTrack) {
            control.setValue(false, { emitEvent: false });
          }
        }
      }
    });
    for (const category of ANALYTICS_CATEGORIES) {
      this.controls[category].valueChanges
        .pipe(takeUntilDestroyed())
        .subscribe((granted) => void this.setCategory(category, granted));
    }
  }

  /** Toggles made during a save are coalesced: the last choice per category is saved next. */
  private async setCategory(category: AnalyticsCategory, granted: boolean): Promise<void> {
    this.wanted.delete(category);
    this.wanted.set(category, granted);
    if (this.saving()) {
      return;
    }
    this.saving.set(true);
    for (const [next, value] of this.drain()) {
      try {
        await this.analytics.setCategory(next, value);
      } catch (err) {
        if (!unsavedDenial(this.analyticsState())) {
          notifyError(this.alerts, err, this.transloco.translate('settings.notSaved'));
        }
      }
    }
    this.saving.set(false);
  }

  /** Oldest wanted change first; entries added while a save runs are picked up by the same loop. */
  private *drain(): Generator<[AnalyticsCategory, boolean]> {
    for (let entry = this.wanted.entries().next(); !entry.done;) {
      this.wanted.delete(entry.value[0]);
      yield entry.value;
      entry = this.wanted.entries().next();
    }
  }

  protected openPolicy(): void {
    openPrivacyPage(this.analytics, this.alerts, this.transloco);
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
        label: this.transloco.translate('settings.privacy.eventsTitle'),
        size: 'm',
        data: state,
      })
      .subscribe();
  }
}
