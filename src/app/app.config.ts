import { provideTaiga } from '@taiga-ui/core';
import {
  ApplicationConfig,
  inject,
  Injector,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
  isDevMode,
} from '@angular/core';
import { provideTransloco } from '@jsverse/transloco';
import { tuiLanguageSwitcher } from '@taiga-ui/i18n';
import { provideRouter, withComponentInputBinding, withRouterConfig } from '@angular/router';
import { routes } from './app.routes';
import { ConnectionEvents } from './core/ipc/connection-events';
import { EditedFiles } from './core/ipc/edited-files';
import { Settings } from './core/settings/settings';
import { provideOpenDialogs } from './shared/open-dialogs';
import { LanguageService } from './core/i18n/language';
import { TranslocoBundleLoader } from './core/i18n/transloco-loader';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // The project dashboard tabs are child routes that read the parent's `projectId`.
    provideRouter(
      routes,
      withComponentInputBinding(),
      withRouterConfig({ paramsInheritanceStrategy: 'always' }),
    ),
    provideTaiga(),
    tuiLanguageSwitcher((language) =>
      language === 'french'
        ? import('@taiga-ui/i18n/languages/french')
        : import('@taiga-ui/i18n/languages/english'),
    ),
    provideTransloco({
      config: {
        availableLangs: ['en', 'fr'],
        defaultLang: 'en',
        fallbackLang: 'en',
        reRenderOnLangChange: true,
        prodMode: !isDevMode(),
        missingHandler: { logMissingKey: true, useFallbackTranslation: true },
      },
      loader: TranslocoBundleLoader,
    }),
    provideOpenDialogs(),
    // Awaited, unlike the backend reads below: a local chunk, and the first frame must not show keys.
    provideAppInitializer(() => inject(LanguageService).ready()),
    // Not awaited: the app must not wait on the backend to render. Lazy: only the host page shows
    // transfers, so the queue stays out of the initial bundle.
    provideAppInitializer(() => {
      const injector = inject(Injector);
      // The theme is already shown from its cache; the backend value replaces it when it arrives.
      void inject(Settings).start();
      void inject(ConnectionEvents).start();
      void inject(EditedFiles).start();
      // The alerts subscribe to the store's snapshot, so a late start still sees it.
      void import('./features/external-editor/edited-alerts').then(({ EditedAlerts }) =>
        injector.get(EditedAlerts).start(),
      );
      void import('./features/workspace/quit-guard').then(({ QuitGuard }) =>
        injector.get(QuitGuard).start(),
      );
      void import('./features/transfers/transfer-queue').then(({ TransferQueue }) =>
        injector.get(TransferQueue).start(),
      );
      void import('./features/analytics/consent-prompter').then(({ ConsentPrompter }) =>
        injector.get(ConsentPrompter).start(),
      );
    }),
  ],
};
