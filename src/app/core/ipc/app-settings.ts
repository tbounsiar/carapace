import { Service } from '@angular/core';
import type { LanguagePreference } from '../i18n/language';
import type { ThemeMode } from '../theme/theme';
import { invokeCommand } from './ipc-error';
import type { KeyType } from './keys';

/** App preferences as stored in `settings.toml`. */
export interface AppPreferences {
  readonly theme: ThemeMode;
  readonly language: LanguagePreference;
  readonly defaultKeyType: KeyType;
  readonly terminalFontSize: number;
  /** Custom folder of the last successful generation; null is the managed keys folder. */
  readonly keyFolder: string | null;
}

export type AppPreferencesPatch = Partial<AppPreferences>;

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
  importLegacy(values: AppPreferencesPatch): Promise<AppPreferences> {
    return invokeCommand<AppPreferences>('import_legacy_settings', { values });
  }
}
