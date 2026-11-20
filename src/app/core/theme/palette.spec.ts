import {
  contrast,
  deriveAccent,
  isAccentColor,
  isPalette,
  PALETTE_TOKENS,
  paletteAccent,
  PALETTES,
  textTarget,
} from './palette';

const HARD_PICKS = ['#ffff00', '#000000', '#808080', '#00ffff', '#ff0000'];
const VARIANTS = ['light', 'dark'] as const;

describe('palette', () => {
  it('recognises the sets and accent colors', () => {
    expect(PALETTES.every(isPalette)).toBe(true);
    expect(isPalette('classic')).toBe(false);
    expect(isPalette(null)).toBe(false);
    expect(isAccentColor('#6b3fc0')).toBe(true);
    expect(isAccentColor('#6B3FC0')).toBe(true);
    for (const value of ['#fff', '#6b3fc0aa', 'red', '6b3fc0', null, 42]) {
      expect(isAccentColor(value)).toBe(false);
    }
  });

  it('computes WCAG contrast ratios', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#ffffff', '#ffffff')).toBe(1);
    // Spec values: Pine dark border on its base, Default light tertiary text on base.
    expect(contrast('#7d918b', '#1c2523')).toBeCloseTo(4.7, 1);
    expect(contrast('#676b82', '#ffffff')).toBeCloseTo(5.25, 1);
  });

  describe.each(PALETTES)('%s', (palette) => {
    it.each(HARD_PICKS)('derives %s into colors that meet every target', (pick) => {
      const derived = deriveAccent(pick, palette);
      const target = textTarget(palette);
      for (const variant of VARIANTS) {
        const colors = derived[variant];
        const surfaces = PALETTE_TOKENS[palette][variant].surfaces;
        for (const surface of surfaces) {
          expect(contrast(colors.accent, surface)).toBeGreaterThanOrEqual(target);
          expect(contrast(colors.hover, surface)).toBeGreaterThanOrEqual(target);
        }
        for (const fill of [colors.accent, colors.hover, colors.pressed]) {
          expect(contrast(colors.on, fill)).toBeGreaterThanOrEqual(4.5);
        }
        expect(colors.selection).toMatch(/^rgba\(\d+, \d+, \d+, 0\.(18|32)\)$/);
      }
    });

    it('keeps a pick that already passes', () => {
      const target = textTarget(palette);
      for (const variant of VARIANTS) {
        const pick = variant === 'light' ? '#1d3fb8' : '#c2d0ff';
        const surfaces = PALETTE_TOKENS[palette][variant].surfaces;
        expect(Math.min(...surfaces.map((s) => contrast(pick, s)))).toBeGreaterThanOrEqual(target);
        const colors = deriveAccent(pick, palette)[variant];
        expect(colors.accent).toBe(pick);
        expect(colors.adjusted).toBe(false);
      }
    });

    it("lists its own accents, which meet the set's targets", () => {
      const own = paletteAccent(palette);
      for (const variant of VARIANTS) {
        expect(own[variant].adjusted).toBe(false);
        for (const surface of PALETTE_TOKENS[palette][variant].surfaces) {
          expect(contrast(own[variant].accent, surface)).toBeGreaterThanOrEqual(3);
        }
      }
    });
  });

  it('darkens a light pick in light mode and keeps it in dark mode', () => {
    const derived = deriveAccent('#ffff00', 'default');
    expect(derived.light.adjusted).toBe(true);
    expect(derived.dark.adjusted).toBe(false);
    expect(derived.dark.accent).toBe('#ffff00');
    expect(derived.light.on).toBe('#ffffff');
    expect(derived.dark.on).toBe('#0f1633');
  });

  it('lightens a dark pick in dark mode only', () => {
    const derived = deriveAccent('#000000', 'high-contrast');
    expect(derived.light).toEqual(expect.objectContaining({ accent: '#000000', adjusted: false }));
    expect(derived.dark.adjusted).toBe(true);
    expect(derived.dark.on).toBe('#000000');
  });

  it('keeps grays gray', () => {
    const { light, dark } = deriveAccent('#808080', 'pine');
    for (const hex of [light.accent, dark.accent]) {
      expect(hex.slice(1, 3)).toBe(hex.slice(3, 5));
      expect(hex.slice(3, 5)).toBe(hex.slice(5, 7));
    }
  });

  it('keeps the hue of a saturated pick', () => {
    const { light } = deriveAccent('#00ffff', 'plum');
    const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(light.accent.slice(i, i + 2), 16));
    expect(r).toBeLessThan(g);
    expect(Math.abs(g - b)).toBeLessThan(8);
  });
});
