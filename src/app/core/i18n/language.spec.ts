import { TestBed } from '@angular/core/testing';
import { TranslocoService } from '@jsverse/transloco';
import { TuiLanguageSwitcherService } from '@taiga-ui/i18n';
import { LANGUAGE_CACHE, LanguageService, systemLanguage } from './language';

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
    expect(systemLanguage(nav(['de-DE']))).toBe('en');
    expect(systemLanguage(nav([]))).toBe('en');
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
    localStorage.setItem(LANGUAGE_CACHE, 'de');
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
