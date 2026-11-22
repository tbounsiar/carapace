import { computed, DestroyRef, DOCUMENT, inject, Injector, Service, signal } from '@angular/core';
import { TranslocoService } from '@jsverse/transloco';
import { TuiLanguageSwitcherService } from '@taiga-ui/i18n';
import { firstValueFrom } from 'rxjs';

/** Interface languages in picker order: by their own name, Latin script first, CJK last. */
export const APP_LANGUAGES = ['de', 'en', 'es', 'fr', 'pt-BR', 'zh-CN'] as const;

export type AppLanguage = (typeof APP_LANGUAGES)[number];
export type LanguagePreference = 'system' | AppLanguage;

export const LANGUAGE_CACHE = 'carapace.language';

/** Each language named in itself, so users find theirs in a UI they cannot read. */
export const LANGUAGE_NAMES: Readonly<Record<AppLanguage, string>> = {
  de: 'Deutsch',
  en: 'English',
  es: 'Español',
  fr: 'Français',
  'pt-BR': 'Português do Brasil',
  'zh-CN': '简体中文',
};

export const TAIGA_LANGUAGES: Readonly<Record<AppLanguage, string>> = {
  de: 'german',
  en: 'english',
  es: 'spanish',
  fr: 'french',
  'pt-BR': 'portuguese',
  'zh-CN': 'chinese',
};

const LOCALES: Readonly<Record<AppLanguage, string>> = {
  de: 'de-DE',
  en: 'en-US',
  es: 'es-ES',
  fr: 'fr-FR',
  'pt-BR': 'pt-BR',
  'zh-CN': 'zh-CN',
};

export function isAppLanguage(value: unknown): value is AppLanguage {
  return (APP_LANGUAGES as readonly unknown[]).includes(value);
}

/** The `Intl` locale of an interface language; an unknown code is English. */
export function localeOf(language: string): string {
  return LOCALES[isAppLanguage(language) ? language : 'en'];
}

export function isLanguagePreference(value: unknown): value is LanguagePreference {
  return value === 'system' || isAppLanguage(value);
}

/**
 * The spec's `system` rule, the same as `native_text.rs` `from_locale` so the page and the native
 * dialogs agree. The primary subtag is compared whole: `frr` is North Frisian, `zha` Zhuang.
 * Traditional Chinese gets English, not Simplified.
 */
export function resolveLocale(locale: string | null | undefined): AppLanguage {
  const tag = (locale ?? '').split(/[.@]/)[0].toLowerCase();
  const [primary, second] = tag.split(/[-_]/);
  switch (primary) {
    case 'fr':
    case 'de':
    case 'es':
      return primary;
    case 'pt':
      return 'pt-BR';
    case 'zh':
      return ['hant', 'cht', 'tw', 'hk', 'mo'].includes(second ?? '') ? 'en' : 'zh-CN';
    default:
      return 'en';
  }
}

export function readCachedLanguage(): LanguagePreference | null {
  try {
    const value = localStorage.getItem(LANGUAGE_CACHE);
    return isLanguagePreference(value) ? value : null;
  } catch {
    return null;
  }
}

/** Only the first OS language counts, as in Rust, which reads a single locale. */
export function systemLanguage(
  nav: Pick<Navigator, 'languages' | 'language'> = navigator,
): AppLanguage {
  return resolveLocale(nav.languages?.[0] ?? nav.language);
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
