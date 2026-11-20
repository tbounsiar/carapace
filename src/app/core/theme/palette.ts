import type { EffectiveTheme } from './theme';

export type Palette = 'default' | 'high-contrast' | 'pine' | 'plum';

export const PALETTES: readonly Palette[] = ['default', 'high-contrast', 'pine', 'plum'];

export function isPalette(value: unknown): value is Palette {
  return PALETTES.includes(value as Palette);
}

const ACCENT_COLOR = /^#[0-9a-f]{6}$/;

/** `#rrggbb`; the stored form is lowercase. */
export function isAccentColor(value: unknown): value is string {
  return typeof value === 'string' && ACCENT_COLOR.test(value.toLowerCase());
}

interface VariantTokens {
  /** base, base-alt, elevation 1-3: the surfaces text and the accent sit on. */
  readonly surfaces: readonly string[];
  /** The set's own `--tui-background-accent-1`. */
  readonly accent: string;
  /** Text on the accent; the light variants all use white. */
  readonly onAccent: string;
}

/** Mirrors `src/palettes.less` (Taiga's values where the set keeps them). */
export const PALETTE_TOKENS: Readonly<Record<Palette, Record<EffectiveTheme, VariantTokens>>> = {
  default: {
    light: {
      surfaces: ['#ffffff', '#f6f6f6', '#ffffff', '#ffffff', '#ffffff'],
      accent: '#526ed3',
      onAccent: '#ffffff',
    },
    dark: {
      surfaces: ['#222222', '#333333', '#292929', '#2f2f2f', '#373737'],
      accent: '#8aa2ff',
      onAccent: '#0f1633',
    },
  },
  'high-contrast': {
    light: {
      surfaces: ['#ffffff', '#f0f0f0', '#ffffff', '#ffffff', '#ffffff'],
      accent: '#1d3fb8',
      onAccent: '#ffffff',
    },
    dark: {
      surfaces: ['#000000', '#141414', '#141414', '#1a1a1a', '#1f1f1f'],
      accent: '#9fb4ff',
      onAccent: '#000000',
    },
  },
  pine: {
    light: {
      surfaces: ['#f9fcfb', '#edf3f1', '#ffffff', '#ffffff', '#ffffff'],
      accent: '#0d6e8c',
      onAccent: '#ffffff',
    },
    dark: {
      surfaces: ['#1c2523', '#263230', '#212b29', '#26312f', '#2c3836'],
      accent: '#5cc8e6',
      onAccent: '#0b1f24',
    },
  },
  plum: {
    light: {
      surfaces: ['#fcfbfe', '#f2eff7', '#ffffff', '#ffffff', '#ffffff'],
      accent: '#6b3fc0',
      onAccent: '#ffffff',
    },
    dark: {
      surfaces: ['#221d29', '#2e2836', '#27212f', '#2c2634', '#332c3c'],
      accent: '#c49bff',
      onAccent: '#1d1028',
    },
  },
};

/** WCAG text target of a set: High contrast asks for 7:1. */
export function textTarget(palette: Palette): number {
  return palette === 'high-contrast' ? 7 : 4.5;
}

export interface AccentVariant {
  /** `--tui-background-accent-1` and `--tui-text-action`. */
  readonly accent: string;
  readonly hover: string;
  readonly pressed: string;
  /** `--tui-text-primary-on-accent-1`. */
  readonly on: string;
  /** `--app-selection`. */
  readonly selection: string;
  /** The applied color is visibly lighter or darker than the pick. */
  readonly adjusted: boolean;
}

export type DerivedAccent = Readonly<Record<EffectiveTheme, AccentVariant>>;

/** The set's own accent per variant, in the shape of a derived one (nothing adjusted). */
export function paletteAccent(palette: Palette): DerivedAccent {
  return {
    light: {
      ...variantOf(palette, 'light', PALETTE_TOKENS[palette].light.accent),
      adjusted: false,
    },
    dark: { ...variantOf(palette, 'dark', PALETTE_TOKENS[palette].dark.accent), adjusted: false },
  };
}

/**
 * The colors applied for a picked accent in each variant of `palette`. Lightness moves away from
 * the background (OKLCH, same hue) until the color reads as text on every surface of the set, so
 * no pick can make links, buttons or the focus ring unreadable.
 */
export function deriveAccent(pick: string, palette: Palette): DerivedAccent {
  return {
    light: deriveVariant(pick, palette, 'light'),
    dark: deriveVariant(pick, palette, 'dark'),
  };
}

const STEP = 0.005;
const HOVER_STEP = 0.06;
const PRESSED_STEP = 0.12;
const ADJUSTED = 0.02;
const SELECTION_ALPHA: Record<EffectiveTheme, number> = { light: 0.18, dark: 0.32 };

function deriveVariant(pick: string, palette: Palette, variant: EffectiveTheme): AccentVariant {
  const target = textTarget(palette);
  const surfaces = PALETTE_TOKENS[palette][variant].surfaces;
  const direction = variant === 'light' ? -1 : 1;
  const [l0, c, h] = toOklch(pick);
  let l = l0;
  let accent = fromOklch(l, c, h);
  const end = variant === 'light' ? 0 : 1;
  while (minContrast(accent, surfaces) < target && l !== end) {
    l = clamp(l + direction * STEP);
    accent = fromOklch(l, c, h);
  }
  const applied = toOklch(accent)[0];
  return {
    ...variantOf(palette, variant, accent),
    adjusted: Math.abs(applied - l0) > ADJUSTED,
  };
}

function variantOf(
  palette: Palette,
  variant: EffectiveTheme,
  accent: string,
): Omit<AccentVariant, 'adjusted'> {
  const direction = variant === 'light' ? -1 : 1;
  const [l, c, h] = toOklch(accent);
  const [r, g, b] = channels(accent);
  return {
    accent,
    hover: fromOklch(clamp(l + direction * HOVER_STEP), c, h),
    pressed: fromOklch(clamp(l + direction * PRESSED_STEP), c, h),
    on: PALETTE_TOKENS[palette][variant].onAccent,
    selection: `rgba(${r}, ${g}, ${b}, ${SELECTION_ALPHA[variant]})`,
  };
}

function minContrast(color: string, surfaces: readonly string[]): number {
  return Math.min(...surfaces.map((surface) => contrast(color, surface)));
}

/** WCAG 2 contrast ratio of two `#rrggbb` colors. */
export function contrast(a: string, b: string): number {
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((v) => toLinear(v / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function channels(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

const clamp = (v: number): number => Math.min(1, Math.max(0, v));

const toLinear = (v: number): number => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

const toGamma = (v: number): number =>
  v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;

function toOklch(hex: string): [number, number, number] {
  const [r, g, b] = channels(hex).map((v) => toLinear(v / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, B), Math.atan2(B, A)];
}

function oklchToLinear(L: number, C: number, h: number): [number, number, number] {
  const A = C * Math.cos(h);
  const B = C * Math.sin(h);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const inGamut = (rgb: readonly number[]): boolean => rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4);

/** The closest sRGB color: same lightness and hue, chroma reduced until it fits. */
function fromOklch(L: number, C: number, h: number): string {
  let rgb = oklchToLinear(L, C, h);
  if (!inGamut(rgb)) {
    let [low, high] = [0, C];
    for (let i = 0; i < 24; i++) {
      const mid = (low + high) / 2;
      if (inGamut(oklchToLinear(L, mid, h))) {
        low = mid;
      } else {
        high = mid;
      }
    }
    rgb = oklchToLinear(L, low, h);
  }
  return (
    '#' +
    rgb
      .map((v) =>
        Math.round(clamp(toGamma(clamp(v))) * 255)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}
