import type { ITheme } from '@xterm/xterm';
import type { XtermAppearance, XtermFactory, XtermView } from './xterm-factory';

/** Test double for xterm, which needs a canvas that jsdom lacks. */
export class FakeXterm implements XtermView {
  cols = 80;
  rows = 24;
  parent: HTMLElement | null = null;
  readonly written: (Uint8Array | string)[] = [];
  theme: ITheme | null = null;
  fontFamily = '';
  fontSize = 0;
  disposed = false;
  fits = 0;
  focused = 0;
  reserved: ((event: KeyboardEvent) => boolean) | null = null;
  private dataListener: ((data: string) => void) | null = null;
  private resizeListener: ((size: { cols: number; rows: number }) => void) | null = null;

  open(parent: HTMLElement): void {
    this.parent = parent;
  }

  write(data: Uint8Array | string): void {
    this.written.push(data);
  }

  onData(listener: (data: string) => void): void {
    this.dataListener = listener;
  }

  onResize(listener: (size: { cols: number; rows: number }) => void): void {
    this.resizeListener = listener;
  }

  setAppearance({ theme, fontFamily, fontSize }: XtermAppearance): void {
    this.theme = theme;
    this.fontFamily = fontFamily;
    this.fontSize = fontSize;
  }

  fit(): void {
    this.fits++;
  }

  focus(): void {
    this.focused++;
  }

  reserveKeys(reserved: (event: KeyboardEvent) => boolean): void {
    this.reserved = reserved;
  }

  dispose(): void {
    this.disposed = true;
  }

  type(data: string): void {
    this.dataListener?.(data);
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.resizeListener?.({ cols, rows });
  }
}

export class FakeXtermFactory implements Pick<XtermFactory, 'create'> {
  readonly created: FakeXterm[] = [];

  create(appearance: XtermAppearance): Promise<XtermView> {
    const view = new FakeXterm();
    view.setAppearance(appearance);
    this.created.push(view);
    return Promise.resolve(view);
  }
}
