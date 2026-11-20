import { Service } from '@angular/core';
import type { LanguagePreference } from '../i18n/language';
import type { ThemeMode } from '../theme/theme';
import { invokeCommand } from './ipc-error';
import type { KeyType } from './keys';
import type { Palette } from '../theme/palette';

/** App preferences as stored in `settings.toml`. */
export interface AppPreferences {
  readonly theme: ThemeMode;
  readonly language: LanguagePreference;
  readonly defaultKeyType: KeyType;
  readonly terminalFontSize: number;
  /** Custom folder of the last successful generation; null is the managed keys folder. */
  readonly keyFolder: string | null;
  readonly palette: Palette;
  /** `#rrggbb` lowercase; null is the color set's own accent. */
  readonly accentColor: string | null;
}

export type AppPreferencesPatch = Partial<AppPreferences>;

/** The color set and accent never lived in webview storage, so they are never imported. */
export type LegacyPreferences = Omit<AppPreferencesPatch, 'palette' | 'accentColor'>;

/** Typed wrapper of the app settings commands. */
@Service()
export class AppSettings {
  read(): Promise<AppPreferences> {
    return invokeCommand<AppPreferences>('app_settings');
  }

  update(patch: AppPreferencesPatch): Promise<AppPreferences> {
    return invokeCommand<AppPreferences>('update_app_settings', { patch });
  }

  /** One-time import of the values kept in webview storage; fields already set are ignored. */
  importLegacy(values: LegacyPreferences): Promise<AppPreferences> {
    return invokeCommand<AppPreferences>('import_legacy_settings', { values });
  }
}
