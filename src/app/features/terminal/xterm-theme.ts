import type { ITheme } from '@xterm/xterm';
import type { EffectiveTheme } from '../../core/theme/theme';

// xterm renders outside the CSS cascade and needs explicit ANSI colors; Taiga has no tokens for them.
const ANSI: Record<EffectiveTheme, ITheme> = {
  dark: {
    black: '#1e1e1e',
    red: '#f0524f',
    green: '#5cb85c',
    yellow: '#e5c07b',
    blue: '#61afef',
    magenta: '#c678dd',
    cyan: '#56b6c2',
    white: '#c8c8c8',
    brightBlack: '#7f848e',
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
    cyan: '#1b7c83',
    white: '#6e7781',
    brightBlack: '#57606a',
    brightRed: '#a40e26',
    brightGreen: '#1a7f37',
    brightYellow: '#633c01',
    brightBlue: '#218bff',
    brightMagenta: '#a475f9',
    brightCyan: '#3192aa',
    brightWhite: '#8c959f',
  },
};

const read = (style: CSSStyleDeclaration, name: string, fallback: string): string =>
  style.getPropertyValue(name).trim() || fallback;

/** Surface colors come from the Taiga tokens resolved on `source`, the palette from `ANSI`. */
export function xtermTheme(source: Element, effective: EffectiveTheme): ITheme {
  const style = getComputedStyle(source);
  const dark = effective === 'dark';
  const background = read(style, '--tui-background-base', dark ? '#222' : '#fff');
  const foreground = read(style, '--tui-text-primary', dark ? '#fff' : '#1b1f3b');
  return {
    ...ANSI[effective],
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground: read(style, '--tui-status-info-pale-hover', 'rgba(112, 182, 246, 0.4)'),
  };
}

export function xtermFont(source: Element): string {
  return read(getComputedStyle(source), '--app-font-mono', 'monospace');
}
