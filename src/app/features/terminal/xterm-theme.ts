import type { ITheme } from '@xterm/xterm';
import type { Palette } from '../../core/theme/palette';
import type { EffectiveTheme } from '../../core/theme/theme';

// xterm renders outside the CSS cascade and needs explicit ANSI colors; Taiga has no tokens for them.
// Standard holds on every base of Default, Pine and Plum; High contrast reaches 7:1 on #000 / #fff.
type AnsiSet = 'standard' | 'high-contrast';

const ANSI: Record<AnsiSet, Record<EffectiveTheme, ITheme>> = {
  standard: {
    dark: {
      black: '#686e7a',
      red: '#ff6b68',
      green: '#5cc77a',
      yellow: '#e5c07b',
      blue: '#61afef',
      magenta: '#c678dd',
      cyan: '#56b6c2',
      white: '#c8c8c8',
      brightBlack: '#8b919c',
      brightRed: '#ff7b72',
      brightGreen: '#7ee787',
      brightYellow: '#f2cc60',
      brightBlue: '#79c0ff',
      brightMagenta: '#d2a8ff',
      brightCyan: '#a5d6ff',
      brightWhite: '#ffffff',
    },
    light: {
      black: '#24292f',
      red: '#cf222e',
      green: '#116329',
      yellow: '#7d4e00',
      blue: '#0550ae',
      magenta: '#8250df',
      cyan: '#17707a',
      white: '#5f6873',
      brightBlack: '#57606a',
      brightRed: '#a40e26',
      brightGreen: '#1a7f37',
      brightYellow: '#633c01',
      brightBlue: '#1866c4',
      brightMagenta: '#8a3fd1',
      brightCyan: '#157a8c',
      brightWhite: '#899099',
    },
  },
  'high-contrast': {
    dark: {
      black: '#5e5e5e',
      red: '#ff7a75',
      green: '#5fe07a',
      yellow: '#ffd75f',
      blue: '#7cb4ff',
      magenta: '#e58cff',
      cyan: '#5fe0e0',
      white: '#d9d9d9',
      brightBlack: '#a0a0a0',
      brightRed: '#ffa3a0',
      brightGreen: '#9cf0ac',
      brightYellow: '#fff0a0',
      brightBlue: '#b0d0ff',
      brightMagenta: '#f0b8ff',
      brightCyan: '#a0f0f0',
      brightWhite: '#ffffff',
    },
    light: {
      black: '#000000',
      red: '#a00000',
      green: '#005c1a',
      yellow: '#5c3d00',
      blue: '#0033a8',
      magenta: '#7a0091',
      cyan: '#005560',
      white: '#555555',
      brightBlack: '#4d4d4d',
      brightRed: '#b00000',
      brightGreen: '#00621d',
      brightYellow: '#704a00',
      brightBlue: '#1a47c8',
      brightMagenta: '#8a1aa3',
      brightCyan: '#00606c',
      brightWhite: '#6b6b6b',
    },
  },
};

const read = (style: CSSStyleDeclaration, name: string, fallback: string): string =>
  style.getPropertyValue(name).trim() || fallback;

/** Surface colors come from the tokens resolved on `source`, the 16 colors from `ANSI`. */
export function xtermTheme(source: Element, effective: EffectiveTheme, palette: Palette): ITheme {
  const style = getComputedStyle(source);
  const dark = effective === 'dark';
  const background = read(style, '--tui-background-base', dark ? '#222' : '#fff');
  const foreground = read(style, '--tui-text-primary', dark ? '#fff' : '#1b1f3b');
  return {
    ...ANSI[palette === 'high-contrast' ? 'high-contrast' : 'standard'][effective],
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground: read(style, '--app-selection', 'rgba(112, 182, 246, 0.4)'),
  };
}

export function xtermFont(source: Element): string {
  return read(getComputedStyle(source), '--app-font-mono', 'monospace');
}
