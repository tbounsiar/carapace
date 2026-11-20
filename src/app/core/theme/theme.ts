import { computed, DOCUMENT, inject, Service, signal } from '@angular/core';
import {
  type DerivedAccent,
  deriveAccent,
  isAccentColor,
  isPalette,
  type Palette,
} from './palette';

export type ThemeMode = 'system' | 'light' | 'dark';
export type EffectiveTheme = 'light' | 'dark';

/** Also the pre-import theme preference; the e2e screenshot helper reads it too. */
export const THEME_CACHE = 'carapace.theme';
export const PALETTE_CACHE = 'carapace.palette';
export const ACCENT_CACHE = 'carapace.accent';
const QUERY = '(prefers-color-scheme: dark)';

/** Custom properties `src/palettes.less` maps onto the Taiga accent tokens. */
const ACCENT_PROPERTIES = ['', '-hover', '-pressed', '-on', '-selection'] as const;
const ACCENT_KEYS = ['accent', 'hover', 'pressed', 'on', 'selection'] as const;

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'system' || value === 'light' || value === 'dark';
}

function readCached<T>(key: string, valid: (value: unknown) => value is T): T | null {
  try {
    const value = localStorage.getItem(key);
    return valid(value) ? value : null;
  } catch {
    return null;
  }
}

function writeCached(key: string, value: string | null): void {
  try {
    if (value === null) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, value);
    }
  } catch {
    // Storage can be unavailable; the next launch then starts from the defaults until the backend answers.
  }
}

export function readCachedTheme(): ThemeMode | null {
  return readCached(THEME_CACHE, isThemeMode);
}

/**
 * The displayed theme: mode, color set and accent. The preferences are persisted by `Settings` in
 * the backend; this keeps synchronous copies in localStorage so the first frame already shows them.
 */
@Service()
export class ThemeService {
  private readonly html = inject(DOCUMENT).documentElement;
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
  readonly palette = signal<Palette>(readCached(PALETTE_CACHE, isPalette) ?? 'default');
  /** The picked accent (`#rrggbb`), null for the set's own. */
  readonly accent = signal<string | null>(readCached(ACCENT_CACHE, isAccentColor));
  /** What the pick becomes in each variant of the current set. */
  readonly accentColors = computed<DerivedAccent | null>(() => {
    const accent = this.accent();
    return accent === null ? null : deriveAccent(accent, this.palette());
  });

  constructor() {
    this.query.addEventListener('change', (event) => this.systemDark.set(event.matches));
    this.paint();
  }

  /** Shows `mode` and refreshes the cache; does not save the preference (see `Settings.setTheme`). */
  apply(mode: ThemeMode): void {
    this.mode.set(mode);
    writeCached(THEME_CACHE, mode);
  }

  /** Shows `palette` and refreshes the cache; does not save it (see `Settings.setPalette`). */
  applyPalette(palette: Palette): void {
    this.palette.set(palette);
    writeCached(PALETTE_CACHE, palette);
    this.paint();
  }

  /** Shows `accent` (null = the set's own) and refreshes the cache; does not save it. */
  applyAccent(accent: string | null): void {
    this.accent.set(accent);
    writeCached(ACCENT_CACHE, accent);
    this.paint();
  }

  /**
   * Synchronous, not an effect: the attributes must be on `html` before the first render, and in
   * the same frame as a change so terminals re-read the tokens after it.
   */
  private paint(): void {
    this.html.setAttribute('data-app-palette', this.palette());
    const colors = this.accentColors();
    for (const variant of ['light', 'dark'] as const) {
      ACCENT_PROPERTIES.forEach((suffix, i) => {
        const name = `--app-accent-${variant}${suffix}`;
        if (colors) {
          this.html.style.setProperty(name, colors[variant][ACCENT_KEYS[i]]);
        } else {
          this.html.style.removeProperty(name);
        }
      });
    }
    if (colors) {
      this.html.setAttribute('data-app-accent', '');
    } else {
      this.html.removeAttribute('data-app-accent');
    }
  }
}
