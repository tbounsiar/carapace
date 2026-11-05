import { signal } from '@angular/core';
import { translate, type TranslocoService } from '@jsverse/transloco';

/** Bumped when the active language changes or its translations finish loading. */
const version = signal(0);
let tracked: TranslocoService | null = null;

/** Called once by the app shell so `uiText` read in a `computed` follows a language switch. */
export function trackLanguage(transloco: TranslocoService): void {
  if (tracked === transloco) {
    return;
  }
  tracked = transloco;
  transloco.events$.subscribe((event) => {
    if (event.type === 'langChanged' || event.type === 'translationLoadSuccess') {
      version.update((n) => n + 1);
    }
  });
}

/**
 * A translated text for helpers that run outside an injection context (toasts, error texts,
 * labels built in pure functions). Reading it in a `computed` makes that computed language-aware.
 */
export function uiText(key: string, params?: Readonly<Record<string, unknown>>): string {
  version();
  return translate(key, params);
}
