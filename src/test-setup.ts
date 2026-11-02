// jsdom does not implement matchMedia, which Taiga UI queries at startup.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }),
});

// jsdom has no ResizeObserver; the terminal panel observes its container to refit xterm.
class ResizeObserverStub {
  observe(): void {
    return;
  }
  unobserve(): void {
    return;
  }
  disconnect(): void {
    return;
  }
}
Object.defineProperty(window, 'ResizeObserver', { writable: true, value: ResizeObserverStub });

// xterm probes a 2D canvas when its module loads; jsdom returns null but logs "Not implemented".
Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  writable: true,
  value: () => null,
});
