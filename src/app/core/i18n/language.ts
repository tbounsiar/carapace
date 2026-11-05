import { computed, DestroyRef, DOCUMENT, inject, Injector, Service, signal } from '@angular/core';
import { TranslocoService } from '@jsverse/transloco';
import { TuiLanguageSwitcherService } from '@taiga-ui/i18n';
import { firstValueFrom } from 'rxjs';

export type LanguagePreference = 'system' | 'en' | 'fr';
export type AppLanguage = 'en' | 'fr';

export const LANGUAGE_CACHE = 'carapace.language';

/** Each language named in itself, so users find theirs in a UI they cannot read. */
export const LANGUAGE_NAMES: Readonly<Record<AppLanguage, string>> = {
  en: 'English',
  fr: 'Français',
};

const TAIGA_LANGUAGES: Readonly<Record<AppLanguage, string>> = {
  en: 'english',
  fr: 'french',
};

const LOCALES: Readonly<Record<AppLanguage, string>> = {
  en: 'en-US',
  fr: 'fr-FR',
};

/** The `Intl` locale of an interface language; anything but French is English. */
export function localeOf(language: string): string {
  return LOCALES[language === 'fr' ? 'fr' : 'en'];
}

export function isLanguagePreference(value: unknown): value is LanguagePreference {
  return value === 'system' || value === 'en' || value === 'fr';
}

export function readCachedLanguage(): LanguagePreference | null {
  try {
    const value = localStorage.getItem(LANGUAGE_CACHE);
    return isLanguagePreference(value) ? value : null;
  } catch {
    return null;
  }
}

export function systemLanguage(
  nav: Pick<Navigator, 'languages' | 'language'> = navigator,
): AppLanguage {
  const first = nav.languages?.[0] ?? nav.language ?? '';
  return first.toLowerCase().startsWith('fr') ? 'fr' : 'en';
}

/** Taiga's switcher reads localStorage in its constructor and throws where storage is blocked. */
function taigaSwitcher(injector: Injector): TuiLanguageSwitcherService | null {
  try {
    return injector.get(TuiLanguageSwitcherService);
  } catch {
    return null;
  }
}

/**
 * The interface language. The preference is persisted by `Settings` in the backend; this keeps a
 * synchronous copy in localStorage so the first frame is already in the right language.
 */
@Service()
export class LanguageService {
  private readonly transloco = inject(TranslocoService);
  private readonly taiga = taigaSwitcher(inject(Injector));
  private readonly document = inject(DOCUMENT);
  private applied: AppLanguage | null = null;

  readonly preference = signal<LanguagePreference>(readCachedLanguage() ?? 'system');
  /** What `system` resolves to; follows `languagechange`. */
  readonly system = signal<AppLanguage>(systemLanguage());
  readonly active = computed<AppLanguage>(() => {
    const preference = this.preference();
    return preference === 'system' ? this.system() : preference;
  });
  readonly locale = computed(() => LOCALES[this.active()]);

  constructor() {
    const onChange = () => {
      this.system.set(systemLanguage());
      this.sync();
    };
    const view = this.document.defaultView;
    view?.addEventListener('languagechange', onChange);
    inject(DestroyRef).onDestroy(() => view?.removeEventListener('languagechange', onChange));
    this.sync();
  }

  /** Shows `preference` and refreshes the cache; does not save it (see `Settings.setLanguage`). */
  apply(preference: LanguagePreference): void {
    this.preference.set(preference);
    try {
      localStorage.setItem(LANGUAGE_CACHE, preference);
    } catch {
      // Storage can be unavailable; the next launch then starts from the system language.
    }
    this.sync();
  }

  /** Resolves once the active language's translations are loaded; never rejects. */
  async ready(): Promise<void> {
    try {
      await firstValueFrom(this.transloco.load(this.active()));
    } catch {
      // Missing keys then show through the fallback language.
    }
  }

  private sync(): void {
    const language = this.active();
    if (language === this.applied) {
      return;
    }
    this.applied = language;
    this.transloco.setActiveLang(language);
    try {
      this.taiga?.setLanguage(TAIGA_LANGUAGES[language]);
    } catch {
      // Same storage failure on write: Taiga's own texts stay in the previous language.
    }
    this.document.documentElement.lang = language;
  }
}
