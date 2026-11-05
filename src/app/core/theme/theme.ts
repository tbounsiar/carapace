import { Service, computed, signal } from '@angular/core';

export type ThemeMode = 'system' | 'light' | 'dark';
export type EffectiveTheme = 'light' | 'dark';

/** Also the pre-import theme preference; the e2e screenshot helper reads it too. */
export const THEME_CACHE = 'carapace.theme';
const QUERY = '(prefers-color-scheme: dark)';

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'system' || value === 'light' || value === 'dark';
}

export function readCachedTheme(): ThemeMode | null {
  try {
    const value = localStorage.getItem(THEME_CACHE);
    return isThemeMode(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * The displayed theme. The preference is persisted by `Settings` in the backend; this keeps a
 * synchronous copy in localStorage so the first frame already has the right theme.
 */
@Service()
export class ThemeService {
  private readonly query = window.matchMedia(QUERY);
  private readonly systemDark = signal(this.query.matches);

  readonly mode = signal<ThemeMode>(readCachedTheme() ?? 'system');
  readonly effective = computed<EffectiveTheme>(() => {
    const mode = this.mode();
    if (mode === 'system') {
      return this.systemDark() ? 'dark' : 'light';
    }
    return mode;
  });

  constructor() {
    this.query.addEventListener('change', (event) => this.systemDark.set(event.matches));
  }

  /** Shows `mode` and refreshes the cache; does not save the preference (see `Settings.setTheme`). */
  apply(mode: ThemeMode): void {
    this.mode.set(mode);
    try {
      localStorage.setItem(THEME_CACHE, mode);
    } catch {
      // Storage can be unavailable; the next launch then starts from the system theme.
    }
  }
}
