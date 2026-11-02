import { Service, computed, signal } from '@angular/core';

export type ThemeMode = 'system' | 'light' | 'dark';
export type EffectiveTheme = 'light' | 'dark';

const STORAGE_KEY = 'carapace.theme';
const QUERY = '(prefers-color-scheme: dark)';

function isMode(value: unknown): value is ThemeMode {
  return value === 'system' || value === 'light' || value === 'dark';
}

function readStored(): ThemeMode {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return isMode(value) ? value : 'system';
  } catch {
    return 'system';
  }
}

@Service()
export class ThemeService {
  private readonly query = window.matchMedia(QUERY);
  private readonly systemDark = signal(this.query.matches);

  readonly mode = signal<ThemeMode>(readStored());
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

  setMode(mode: ThemeMode): void {
    this.mode.set(mode);
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // Storage can be unavailable; the choice then lasts for the session only.
    }
  }
}
