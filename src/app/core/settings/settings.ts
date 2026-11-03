import { inject, Service, signal } from '@angular/core';
import type { KeyType } from '../ipc/keys';
import { type ThemeMode, ThemeService } from '../theme/theme';

export const KEY_TYPE_STORAGE = 'carapace.keyType';
export const FONT_SIZE_STORAGE = 'carapace.terminalFontSize';
export const KEY_FOLDER_STORAGE = 'carapace.keyFolder';
export const KEY_FOLDER_MAX = 4096;

export const DEFAULT_KEY_TYPE: KeyType = 'ed25519';
export const FONT_SIZE_MIN = 10;
export const FONT_SIZE_MAX = 24;
export const DEFAULT_FONT_SIZE = 13;

export function isKeyType(value: unknown): value is KeyType {
  return value === 'ed25519' || value === 'rsa4096';
}

export function isFontSize(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= FONT_SIZE_MIN &&
    value <= FONT_SIZE_MAX
  );
}

const FOLDER_PATH = /^(\/|~\/|[A-Za-z]:[\\/])/;

export function isKeyFolder(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= KEY_FOLDER_MAX &&
    value.trim() === value &&
    FOLDER_PATH.test(value)
  );
}

function read<T>(
  key: string,
  parse: (raw: string) => unknown,
  valid: (v: unknown) => v is T,
  fallback: T,
): T {
  try {
    const raw = localStorage.getItem(key);
    const value = raw === null ? null : parse(raw);
    return valid(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable; the preference then lasts for the session only.
  }
}

/** UI preferences kept in localStorage. The theme is stored by `ThemeService`. */
@Service()
export class Settings {
  private readonly themeService = inject(ThemeService);

  readonly theme = this.themeService.mode;
  readonly defaultKeyType = signal<KeyType>(
    read(KEY_TYPE_STORAGE, (raw) => raw, isKeyType, DEFAULT_KEY_TYPE),
  );
  readonly terminalFontSize = signal<number>(
    read(FONT_SIZE_STORAGE, (raw) => Number(raw), isFontSize, DEFAULT_FONT_SIZE),
  );

  /** Custom folder of the last successful generation; null is the managed keys folder. */
  readonly keyFolder = signal<string | null>(
    read<string | null>(KEY_FOLDER_STORAGE, (raw) => raw, isKeyFolder, null),
  );

  setTheme(mode: ThemeMode): void {
    this.themeService.setMode(mode);
  }

  setDefaultKeyType(type: KeyType): void {
    if (!isKeyType(type)) {
      return;
    }
    this.defaultKeyType.set(type);
    write(KEY_TYPE_STORAGE, type);
  }

  /** Out-of-range values are ignored, so a half-typed number never reaches the terminals. */
  setTerminalFontSize(size: number | null): void {
    if (!isFontSize(size)) {
      return;
    }
    this.terminalFontSize.set(size);
    write(FONT_SIZE_STORAGE, String(size));
  }

  setKeyFolder(dir: string | null): void {
    if (dir !== null && !isKeyFolder(dir)) {
      return;
    }
    this.keyFolder.set(dir);
    if (dir === null) {
      try {
        localStorage.removeItem(KEY_FOLDER_STORAGE);
      } catch {
        // See `write`.
      }
    } else {
      write(KEY_FOLDER_STORAGE, dir);
    }
  }
}
