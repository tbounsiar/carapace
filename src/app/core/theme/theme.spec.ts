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

  beforeEach(() => {
    localStorage.clear();
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
});
