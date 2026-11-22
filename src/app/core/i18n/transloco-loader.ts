import { Service } from '@angular/core';
import type { Translation, TranslocoLoader } from '@jsverse/transloco';

/** One literal `import()` per language, so each is its own lazy chunk. */
const LOADERS: Readonly<Record<string, () => Promise<{ default: Translation }>>> = {
  de: () => import('../../i18n/de'),
  en: () => import('../../i18n/en'),
  es: () => import('../../i18n/es'),
  fr: () => import('../../i18n/fr'),
  'pt-BR': () => import('../../i18n/pt-BR'),
  'zh-CN': () => import('../../i18n/zh-CN'),
};

/** Translations are bundled chunks, not fetched assets: the CSP allows no `connect-src` for them. */
@Service()
export class TranslocoBundleLoader implements TranslocoLoader {
  async getTranslation(lang: string): Promise<Translation> {
    const module = await (LOADERS[lang] ?? LOADERS['en'])();
    return module.default;
  }
}
