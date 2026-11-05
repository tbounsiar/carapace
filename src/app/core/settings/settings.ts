import { inject, Service, signal, type WritableSignal } from '@angular/core';
import { TuiNotificationService } from '@taiga-ui/core';
import { notifyError } from '../../shared/save-error';
import { type AppPreferences, type AppPreferencesPatch, AppSettings } from '../ipc/app-settings';
import { isLanguagePreference, type LanguagePreference, LanguageService } from '../i18n/language';
import type { KeyType } from '../ipc/keys';
import { isThemeMode, readCachedTheme, type ThemeMode, ThemeService } from '../theme/theme';

export const KEY_TYPE_STORAGE = 'carapace.keyType';
export const FONT_SIZE_STORAGE = 'carapace.terminalFontSize';
export const KEY_FOLDER_STORAGE = 'carapace.keyFolder';
/** Set once the webview-stored preferences reached the backend (the theme key stays as a cache). */
export const IMPORTED_STORAGE = 'carapace.settingsImported';
export const KEY_FOLDER_MAX = 4096;

export const DEFAULT_KEY_TYPE: KeyType = 'ed25519';
export const FONT_SIZE_MIN = 10;
export const FONT_SIZE_MAX = 24;
export const DEFAULT_FONT_SIZE = 13;

export function isKeyType(value: unknown): value is KeyType {
  return value === 'ed25519' || value === 'rsa4096';
}

export function isFontSize(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= FONT_SIZE_MIN &&
    value <= FONT_SIZE_MAX
  );
}

const FOLDER_PATH = /^(\/|~\/|[A-Za-z]:[\\/])/;

export function isKeyFolder(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= KEY_FOLDER_MAX &&
    value.trim() === value &&
    FOLDER_PATH.test(value)
  );
}

type Field = keyof AppPreferences;

const VALID: { readonly [K in Field]: (value: unknown) => value is AppPreferences[K] } = {
  theme: isThemeMode,
  language: isLanguagePreference,
  defaultKeyType: isKeyType,
  terminalFontSize: isFontSize,
  keyFolder: (value): value is string | null => value === null || isKeyFolder(value),
};

function storage(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

function getItem(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** Valid preferences still kept in webview storage from before the backend file; empty once imported. */
export function readLegacy(): AppPreferencesPatch {
  if (getItem(IMPORTED_STORAGE) !== null) {
    return {};
  }
  const values: { -readonly [K in Field]?: AppPreferences[K] } = {};
  const theme = readCachedTheme();
  if (theme !== null) {
    values.theme = theme;
  }
  const keyType = getItem(KEY_TYPE_STORAGE);
  if (isKeyType(keyType)) {
    values.defaultKeyType = keyType;
  }
  const fontSize = getItem(FONT_SIZE_STORAGE);
  if (fontSize !== null && isFontSize(Number(fontSize))) {
    values.terminalFontSize = Number(fontSize);
  }
  const keyFolder = getItem(KEY_FOLDER_STORAGE);
  if (isKeyFolder(keyFolder)) {
    values.keyFolder = keyFolder;
  }
  return values;
}

/** A language this build does not know (a newer version wrote it) reads as `system`. */
function normalize<T extends AppPreferencesPatch>(values: T): T {
  if (values.language === undefined || isLanguagePreference(values.language)) {
    return values;
  }
  return { ...values, language: 'system' } as T;
}

function markImported(): void {
  try {
    const store = storage();
    store?.removeItem(KEY_TYPE_STORAGE);
    store?.removeItem(FONT_SIZE_STORAGE);
    store?.removeItem(KEY_FOLDER_STORAGE);
    store?.setItem(IMPORTED_STORAGE, '1');
  } catch {
    // The backend ignores an import of fields already set, so a retry next launch is harmless.
  }
}

/**
 * App preferences, persisted by the backend in `settings.toml`. Setters update the signal at once
 * and save in the background; a failed save restores the last saved value and shows a toast.
 */
@Service()
export class Settings {
  private readonly themeService = inject(ThemeService);
  private readonly languageService = inject(LanguageService);
  private readonly ipc = inject(AppSettings);
  private readonly alerts = inject(TuiNotificationService);
  private readonly legacy = readLegacy();

  readonly theme = this.themeService.mode;
  readonly language = this.languageService.preference;
  readonly defaultKeyType = signal<KeyType>(this.legacy.defaultKeyType ?? DEFAULT_KEY_TYPE);
  readonly terminalFontSize = signal<number>(this.legacy.terminalFontSize ?? DEFAULT_FONT_SIZE);
  /** Custom folder of the last successful generation; null is the managed keys folder. */
  readonly keyFolder = signal<string | null>(this.legacy.keyFolder ?? null);

  private readonly fields: { readonly [K in Field]: WritableSignal<AppPreferences[K]> } = {
    theme: this.themeService.mode,
    language: this.languageService.preference,
    defaultKeyType: this.defaultKeyType,
    terminalFontSize: this.terminalFontSize,
    keyFolder: this.keyFolder,
  };
  /** Last values the backend confirmed (until it answers, what the app started with). */
  private confirmed: AppPreferences = this.snapshot();
  /** Fields the user changed this session: a late startup read must not overwrite them. */
  private readonly touched = new Set<Field>();
  private queued: AppPreferencesPatch = {};
  private writing = false;
  private started = false;

  /** Reads the backend once, importing the webview-stored values first. Never throws. */
  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    const legacy = this.legacy;
    let loaded: AppPreferences | null = null;
    // Fields kept from storage this session when the import fails; it is retried next launch.
    let keep: readonly Field[] = [];
    if (Object.keys(legacy).length > 0) {
      try {
        loaded = (await this.ipc.importLegacy(legacy)) ?? null;
        markImported();
      } catch {
        keep = Object.keys(legacy) as Field[];
      }
    } else if (getItem(IMPORTED_STORAGE) === null) {
      markImported();
    }
    if (loaded === null) {
      try {
        loaded = (await this.ipc.read()) ?? null;
      } catch {
        return;
      }
    }
    if (loaded === null) {
      return;
    }
    loaded = normalize(loaded);
    for (const field of Object.keys(this.fields) as Field[]) {
      if (this.touched.has(field) || !VALID[field](loaded[field])) {
        continue;
      }
      this.confirm(field, loaded[field]);
      if (!keep.includes(field)) {
        this.show(field, loaded[field]);
      }
    }
  }

  setTheme(mode: ThemeMode): void {
    if (isThemeMode(mode)) {
      this.write('theme', mode);
    }
  }

  setLanguage(preference: LanguagePreference): void {
    if (isLanguagePreference(preference)) {
      this.write('language', preference);
    }
  }

  setDefaultKeyType(type: KeyType): void {
    if (isKeyType(type)) {
      this.write('defaultKeyType', type);
    }
  }

  /** Out-of-range values are ignored, so a half-typed number never reaches the terminals. */
  setTerminalFontSize(size: number | null): void {
    if (isFontSize(size)) {
      this.write('terminalFontSize', size);
    }
  }

  setKeyFolder(dir: string | null): void {
    if (dir === null || isKeyFolder(dir)) {
      this.write('keyFolder', dir);
    }
  }

  private write<K extends Field>(field: K, value: AppPreferences[K]): void {
    // A slider emits the same value on input and change; it is already shown or being saved.
    if (this.fields[field]() === value) {
      return;
    }
    this.touched.add(field);
    this.show(field, value);
    this.queued = { ...this.queued, [field]: value };
    if (!this.writing) {
      void this.flush();
    }
  }

  /** One save at a time; changes made meanwhile (a dragged slider) are merged into the next one. */
  private async flush(): Promise<void> {
    this.writing = true;
    while (Object.keys(this.queued).length > 0) {
      const sent = this.queued;
      this.queued = {};
      let failed = false;
      let failure: unknown;
      try {
        const saved: AppPreferencesPatch = normalize((await this.ipc.update(sent)) ?? {});
        this.confirmed = { ...this.confirmed, ...sent };
        for (const field of Object.keys(this.fields) as Field[]) {
          if (VALID[field](saved[field])) {
            this.confirm(field, saved[field]);
          }
        }
      } catch (err) {
        failed = true;
        failure = err;
      }
      for (const field of Object.keys(sent) as Field[]) {
        // A newer change of this field is queued: it wins over this result.
        if (!(field in this.queued)) {
          this.show(field, this.confirmed[field]);
        }
      }
      if (failed) {
        notifyError(this.alerts, failure, 'Setting not saved');
      }
    }
    this.writing = false;
  }

  private confirm<K extends Field>(field: K, value: AppPreferences[K]): void {
    this.confirmed = { ...this.confirmed, [field]: value };
  }

  private show<K extends Field>(field: K, value: AppPreferences[K]): void {
    if (field === 'theme') {
      this.themeService.apply(value as ThemeMode);
    } else if (field === 'language') {
      this.languageService.apply(value as LanguagePreference);
    } else {
      this.fields[field].set(value);
    }
  }

  private snapshot(): AppPreferences {
    return {
      theme: this.themeService.mode(),
      language: this.languageService.preference(),
      defaultKeyType: this.defaultKeyType(),
      terminalFontSize: this.terminalFontSize(),
      keyFolder: this.keyFolder(),
    };
  }
}
