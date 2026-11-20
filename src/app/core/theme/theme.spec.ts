import { TestBed } from '@angular/core/testing';
import { ThemeService } from './theme';

type Listener = (event: { matches: boolean }) => void;

class FakeMediaQuery {
  matches = false;
  private listeners: Listener[] = [];

  addEventListener(_: string, fn: Listener): void {
    this.listeners.push(fn);
  }

  emit(matches: boolean): void {
    this.matches = matches;
    this.listeners.forEach((fn) => fn({ matches }));
  }
}

describe('ThemeService', () => {
  let media: FakeMediaQuery;
  const original = window.matchMedia;

  const html = document.documentElement;

  beforeEach(() => {
    localStorage.clear();
    html.removeAttribute('data-app-palette');
    html.removeAttribute('data-app-accent');
    html.removeAttribute('style');
    media = new FakeMediaQuery();
    window.matchMedia = (() => media) as unknown as typeof window.matchMedia;
  });

  afterEach(() => {
    window.matchMedia = original;
    vi.restoreAllMocks();
  });

  const create = () => TestBed.inject(ThemeService);

  it('defaults to system mode', () => {
    const service = create();
    expect(service.mode()).toBe('system');
    expect(service.effective()).toBe('light');
  });

  it('follows prefers-color-scheme in system mode', () => {
    const service = create();
    media.emit(true);
    expect(service.effective()).toBe('dark');
    media.emit(false);
    expect(service.effective()).toBe('light');
  });

  it('ignores system changes in manual mode', () => {
    const service = create();
    service.apply('light');
    media.emit(true);
    expect(service.effective()).toBe('light');
  });

  it('caches the applied mode', () => {
    const service = create();
    service.apply('dark');
    expect(service.mode()).toBe('dark');
    expect(localStorage.getItem('carapace.theme')).toBe('dark');
  });

  it('starts from the cached mode, before any backend answer', () => {
    localStorage.setItem('carapace.theme', 'dark');
    const service = create();
    expect(service.mode()).toBe('dark');
    expect(service.effective()).toBe('dark');
  });

  it('falls back to system on an invalid stored value', () => {
    localStorage.setItem('carapace.theme', 'purple');
    expect(create().mode()).toBe('system');
  });

  it('works without storage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const service = create();
    expect(service.mode()).toBe('system');
    service.apply('dark');
    expect(service.effective()).toBe('dark');
  });

  describe('color set and accent', () => {
    it('starts on Default without an accent and marks html at once', () => {
      const service = create();
      expect(service.palette()).toBe('default');
      expect(service.accent()).toBeNull();
      expect(html.getAttribute('data-app-palette')).toBe('default');
      expect(html.hasAttribute('data-app-accent')).toBe(false);
    });

    it('starts from the cached set and accent, before any backend answer', () => {
      localStorage.setItem('carapace.palette', 'plum');
      localStorage.setItem('carapace.accent', '#ffff00');
      const service = create();
      expect(service.palette()).toBe('plum');
      expect(service.accent()).toBe('#ffff00');
      expect(html.getAttribute('data-app-palette')).toBe('plum');
      expect(html.hasAttribute('data-app-accent')).toBe(true);
      expect(html.style.getPropertyValue('--app-accent-dark')).toBe('#ffff00');
      expect(html.style.getPropertyValue('--app-accent-light')).not.toBe('#ffff00');
    });

    it('ignores invalid cached values', () => {
      localStorage.setItem('carapace.palette', 'classic');
      localStorage.setItem('carapace.accent', 'red');
      const service = create();
      expect(service.palette()).toBe('default');
      expect(service.accent()).toBeNull();
    });

    it('applies and caches a set, re-deriving the accent for it', () => {
      const service = create();
      service.applyAccent('#808080');
      const before = html.style.getPropertyValue('--app-accent-dark');
      service.applyPalette('high-contrast');
      expect(html.getAttribute('data-app-palette')).toBe('high-contrast');
      expect(localStorage.getItem('carapace.palette')).toBe('high-contrast');
      expect(html.style.getPropertyValue('--app-accent-dark')).not.toBe(before);
      expect(service.accentColors()?.dark.on).toBe('#000000');
    });

    it('sets every accent property and clears them with null', () => {
      const service = create();
      service.applyAccent('#6b3fc0');
      expect(localStorage.getItem('carapace.accent')).toBe('#6b3fc0');
      for (const variant of ['light', 'dark']) {
        for (const suffix of ['', '-hover', '-pressed', '-on', '-selection']) {
          expect(html.style.getPropertyValue(`--app-accent-${variant}${suffix}`)).not.toBe('');
        }
      }
      service.applyAccent(null);
      expect(localStorage.getItem('carapace.accent')).toBeNull();
      expect(html.hasAttribute('data-app-accent')).toBe(false);
      expect(html.style.getPropertyValue('--app-accent-light')).toBe('');
    });
  });
});
