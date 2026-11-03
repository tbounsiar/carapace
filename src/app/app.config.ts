import { provideTaiga } from '@taiga-ui/core';
import {
  ApplicationConfig,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { routes } from './app.routes';
import { TransferQueue } from './features/transfers/transfer-queue';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withComponentInputBinding()),
    provideTaiga(),
    // Not awaited: the app must not wait on the backend to render.
    provideAppInitializer(() => {
      void inject(TransferQueue).start();
    }),
  ],
};
