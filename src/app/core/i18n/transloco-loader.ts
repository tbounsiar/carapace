import { Service } from '@angular/core';
import type { Translation, TranslocoLoader } from '@jsverse/transloco';

/** Translations are bundled chunks, not fetched assets: the CSP allows no `connect-src` for them. */
@Service()
export class TranslocoBundleLoader implements TranslocoLoader {
  async getTranslation(lang: string): Promise<Translation> {
    const module = lang === 'fr' ? await import('../../i18n/fr') : await import('../../i18n/en');
    return module.default;
  }
}
