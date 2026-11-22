import {
  type EnvironmentProviders,
  importProvidersFrom,
  makeEnvironmentProviders,
} from '@angular/core';
import { TRANSLOCO_TRANSPILER, TranslocoTestingModule } from '@jsverse/transloco';
import { IcuTranspiler } from '../app/core/i18n/icu-transpiler';
import { APP_LANGUAGES } from '../app/core/i18n/language';
import de from '../app/i18n/de';
import en from '../app/i18n/en';
import es from '../app/i18n/es';
import fr from '../app/i18n/fr';
import ptBR from '../app/i18n/pt-BR';
import zhCN from '../app/i18n/zh-CN';

/** The real translations, loaded synchronously, English active: specs assert on English text. */
export function provideTranslocoTesting(): EnvironmentProviders {
  return makeEnvironmentProviders([
    importProvidersFrom(
      TranslocoTestingModule.forRoot({
        langs: { de, en, es, fr, 'pt-BR': ptBR, 'zh-CN': zhCN },
        translocoConfig: {
          availableLangs: [...APP_LANGUAGES],
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
