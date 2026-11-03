import { provideTaiga } from '@taiga-ui/core';
import {
  ApplicationConfig,
  inject,
  Injector,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { provideRouter, withComponentInputBinding, withRouterConfig } from '@angular/router';
import { routes } from './app.routes';
import { ConnectionEvents } from './core/ipc/connection-events';
import { provideOpenDialogs } from './shared/open-dialogs';

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
    provideOpenDialogs(),
    // Not awaited: the app must not wait on the backend to render. Lazy: only the host page shows
    // transfers, so the queue stays out of the initial bundle.
    provideAppInitializer(() => {
      const injector = inject(Injector);
      void inject(ConnectionEvents).start();
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
