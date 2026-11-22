import { TestBed } from '@angular/core/testing';
import { TranslocoService } from '@jsverse/transloco';
import { TuiLanguageSwitcherService } from '@taiga-ui/i18n';
import {
  APP_LANGUAGES,
  type AppLanguage,
  isLanguagePreference,
  LANGUAGE_CACHE,
  LanguageService,
  localeOf,
  resolveLocale,
  systemLanguage,
} from './language';

// The same table as `native_text.rs`, so the page and the native dialogs resolve alike.
const SYSTEM_CASES: readonly (readonly [string | null, AppLanguage])[] = [
  ['fr', 'fr'],
  ['fr-FR', 'fr'],
  ['FR-ca', 'fr'],
  ['fr_BE', 'fr'],
  ['fr_FR.UTF-8@euro', 'fr'],
  ['frr', 'en'],
  ['frr-DE', 'en'],
  ['f', 'en'],
  ['de', 'de'],
  ['de-DE', 'de'],
  ['de-AT', 'de'],
  ['de-CH', 'de'],
  ['de_DE@euro', 'de'],
  ['del', 'en'],
  ['es', 'es'],
  ['es-ES', 'es'],
  ['es-419', 'es'],
  ['es_MX.UTF-8', 'es'],
  ['est', 'en'],
  ['pt', 'pt-BR'],
  ['pt-BR', 'pt-BR'],
  ['pt-PT', 'pt-BR'],
  ['pt_BR.utf8', 'pt-BR'],
  ['zh', 'zh-CN'],
  ['zh-CN', 'zh-CN'],
  ['zh_CN.UTF-8', 'zh-CN'],
  ['zh-SG', 'zh-CN'],
  ['zh-MY', 'zh-CN'],
  ['zh-US', 'zh-CN'],
  ['zh-Hans', 'zh-CN'],
  ['zh-Hans-CN', 'zh-CN'],
  ['zh-Hans-HK', 'zh-CN'],
  ['zh-CHS', 'zh-CN'],
  ['zh-TW', 'en'],
  ['zh_TW.UTF-8', 'en'],
  ['zh-HK', 'en'],
  ['zh-MO', 'en'],
  ['zh-Hant', 'en'],
  ['zh-Hant-TW', 'en'],
  ['zh-Hant-HK', 'en'],
  ['ZH-hant-cn', 'en'],
  ['zh-CHT', 'en'],
  ['zha', 'en'],
  ['en-US', 'en'],
  ['en_GB.UTF-8', 'en'],
  ['nl-NL', 'en'],
  ['ja-JP', 'en'],
  ['C', 'en'],
  ['C.UTF-8', 'en'],
  ['POSIX', 'en'],
  ['', 'en'],
  ['-', 'en'],
  [null, 'en'],
];

const TAIGA: Readonly<Record<AppLanguage, string>> = {
  de: 'german',
  en: 'english',
  es: 'spanish',
  fr: 'french',
  'pt-BR': 'portuguese',
  'zh-CN': 'chinese',
};

describe('resolveLocale', () => {
  it.each(SYSTEM_CASES)('resolves %j to %s', (locale, language) => {
    expect(resolveLocale(locale)).toBe(language);
  });
});

describe('language codes', () => {
  it('accept exactly system and the six languages', () => {
    for (const value of ['system', ...APP_LANGUAGES]) {
      expect(isLanguagePreference(value), value).toBe(true);
    }
    for (const value of ['', 'nl', 'pt', 'zh', 'zh-TW', 'EN', null, 3]) {
      expect(isLanguagePreference(value), String(value)).toBe(false);
    }
  });

  it('map each language to its Intl locale, English otherwise', () => {
    expect(APP_LANGUAGES.map(localeOf)).toEqual([
      'de-DE',
      'en-US',
      'es-ES',
      'fr-FR',
      'pt-BR',
      'zh-CN',
    ]);
    expect(localeOf('nl')).toBe('en-US');
  });
});

describe('systemLanguage', () => {
  const nav = (languages: readonly string[] | undefined, language = '') =>
    ({ languages, language }) as Pick<Navigator, 'languages' | 'language'>;

  it('picks French for any French first language', () => {
    for (const tag of ['fr', 'fr-FR', 'FR-ca', 'fr-BE']) {
      expect(systemLanguage(nav([tag, 'en-US']))).toBe('fr');
    }
  });

  it('picks English otherwise, from the first language only', () => {
    expect(systemLanguage(nav(['en-GB', 'fr-FR']))).toBe('en');
    expect(systemLanguage(nav(['nl-NL', 'de-DE']))).toBe('en');
    expect(systemLanguage(nav(['zh-TW', 'zh-CN']))).toBe('en');
    expect(systemLanguage(nav([]))).toBe('en');
  });

  it('picks the new languages from the first language', () => {
    expect(systemLanguage(nav(['de-AT', 'en-US']))).toBe('de');
    expect(systemLanguage(nav(['es-419']))).toBe('es');
    expect(systemLanguage(nav(['pt-PT']))).toBe('pt-BR');
    expect(systemLanguage(nav(['zh-Hans-CN']))).toBe('zh-CN');
  });

  it('falls back to navigator.language', () => {
    expect(systemLanguage(nav(undefined, 'fr-CH'))).toBe('fr');
    expect(systemLanguage(nav(undefined, ''))).toBe('en');
  });
});

describe('LanguageService', () => {
  let languages: string[];

  beforeEach(() => {
    localStorage.clear();
    languages = ['en-US'];
    vi.spyOn(navigator, 'languages', 'get').mockImplementation(() => languages);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.documentElement.lang = 'en';
  });

  const create = () => TestBed.inject(LanguageService);
  const transloco = () => TestBed.inject(TranslocoService);

  it('follows the system by default', () => {
    languages = ['fr-FR'];
    const taiga = vi.spyOn(TuiLanguageSwitcherService.prototype, 'setLanguage');
    const service = create();
    expect(service.preference()).toBe('system');
    expect(service.active()).toBe('fr');
    expect(service.locale()).toBe('fr-FR');
    expect(transloco().getActiveLang()).toBe('fr');
    expect(taiga).toHaveBeenCalledWith('french');
    expect(document.documentElement.lang).toBe('fr');
  });

  it('starts from the cached preference', () => {
    localStorage.setItem(LANGUAGE_CACHE, 'fr');
    const service = create();
    expect(service.preference()).toBe('fr');
    expect(service.active()).toBe('fr');
  });

  it('ignores an invalid cache', () => {
    localStorage.setItem(LANGUAGE_CACHE, 'nl');
    expect(create().preference()).toBe('system');
  });

  it('starts when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(create().preference()).toBe('system');
  });

  it('applies a preference everywhere and caches it', () => {
    const service = create();
    const taiga = vi.spyOn(TestBed.inject(TuiLanguageSwitcherService), 'setLanguage');
    service.apply('fr');
    expect(localStorage.getItem(LANGUAGE_CACHE)).toBe('fr');
    expect(transloco().getActiveLang()).toBe('fr');
    expect(transloco().translate('settings.language.title')).toBe('Langue');
    expect(taiga).toHaveBeenLastCalledWith('french');
    expect(document.documentElement.lang).toBe('fr');

    service.apply('en');
    expect(transloco().getActiveLang()).toBe('en');
    expect(taiga).toHaveBeenLastCalledWith('english');
    expect(document.documentElement.lang).toBe('en');
  });

  it.each(APP_LANGUAGES)('loads %s with its Taiga language, locale and html lang', (code) => {
    const service = create();
    const taiga = vi.spyOn(TestBed.inject(TuiLanguageSwitcherService), 'setLanguage');
    service.apply(code === 'en' ? 'fr' : 'en');
    service.apply(code);
    expect(transloco().getActiveLang()).toBe(code);
    expect(taiga).toHaveBeenLastCalledWith(TAIGA[code]);
    expect(service.locale()).toBe(localeOf(code));
    expect(document.documentElement.lang).toBe(code);
    expect(localStorage.getItem(LANGUAGE_CACHE)).toBe(code);
  });

  it('shows each language in its own words', () => {
    const service = create();
    const titles = APP_LANGUAGES.map((code) => {
      service.apply(code);
      return transloco().translate('settings.language.title');
    });
    expect(titles).toEqual(['Sprache', 'Language', 'Idioma', 'Langue', 'Idioma', '语言']);
  });

  it('follows a Traditional Chinese system in English and a Simplified one in Chinese', () => {
    languages = ['zh-Hant-TW'];
    const service = create();
    expect(service.active()).toBe('en');
    languages = ['zh-CN'];
    window.dispatchEvent(new Event('languagechange'));
    expect(service.active()).toBe('zh-CN');
    expect(document.documentElement.lang).toBe('zh-CN');
  });

  it('re-resolves system on languagechange, only while following the system', () => {
    const service = create();
    expect(service.active()).toBe('en');
    languages = ['fr-CA'];
    window.dispatchEvent(new Event('languagechange'));
    expect(service.system()).toBe('fr');
    expect(service.active()).toBe('fr');
    expect(document.documentElement.lang).toBe('fr');

    service.apply('en');
    languages = ['fr-FR'];
    window.dispatchEvent(new Event('languagechange'));
    expect(service.system()).toBe('fr');
    expect(service.active()).toBe('en');
    expect(document.documentElement.lang).toBe('en');
  });

  it('is ready once the active translations are loaded', async () => {
    await expect(create().ready()).resolves.toBeUndefined();
  });
});
