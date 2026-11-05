import {
  type EnvironmentProviders,
  importProvidersFrom,
  makeEnvironmentProviders,
} from '@angular/core';
import { TRANSLOCO_TRANSPILER, TranslocoTestingModule } from '@jsverse/transloco';
import { IcuTranspiler } from '../app/core/i18n/icu-transpiler';
import en from '../app/i18n/en';
import fr from '../app/i18n/fr';

/** The real translations, loaded synchronously, English active: specs assert on English text. */
export function provideTranslocoTesting(): EnvironmentProviders {
  return makeEnvironmentProviders([
    importProvidersFrom(
      TranslocoTestingModule.forRoot({
        langs: { en, fr },
        translocoConfig: {
          availableLangs: ['en', 'fr'],
          defaultLang: 'en',
          fallbackLang: 'en',
          reRenderOnLangChange: true,
        },
        preloadLangs: true,
      }),
    ),
    { provide: TRANSLOCO_TRANSPILER, useClass: IcuTranspiler },
  ]);
}
