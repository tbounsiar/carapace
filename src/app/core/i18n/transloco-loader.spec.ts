import { APP_LANGUAGES } from './language';
import { TranslocoBundleLoader } from './transloco-loader';

const TITLES = ['Sprache', 'Language', 'Idioma', 'Langue', 'Idioma', '语言'];

const title = (translation: unknown) =>
  (translation as { settings: { language: { title: string } } }).settings.language.title;

describe('TranslocoBundleLoader', () => {
  it('loads each language from its own chunk', async () => {
    const loader = new TranslocoBundleLoader();
    const titles = await Promise.all(
      APP_LANGUAGES.map(async (code) => title(await loader.getTranslation(code))),
    );
    expect(titles).toEqual(TITLES);
  });

  it('falls back to English for an unknown language', async () => {
    expect(title(await new TranslocoBundleLoader().getTranslation('nl'))).toBe('Language');
  });
});
