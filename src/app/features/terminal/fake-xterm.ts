import type { ITheme } from '@xterm/xterm';
import type { XtermFactory, XtermView } from './xterm-factory';

/** Test double for xterm, which needs a canvas that jsdom lacks. */
export class FakeXterm implements XtermView {
  cols = 80;
  rows = 24;
  parent: HTMLElement | null = null;
  readonly written: (Uint8Array | string)[] = [];
  theme: ITheme | null = null;
  fontFamily = '';
  disposed = false;
  fits = 0;
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

  setAppearance(theme: ITheme, fontFamily: string): void {
    this.theme = theme;
    this.fontFamily = fontFamily;
  }

  fit(): void {
    this.fits++;
  }

  focus(): void {
    return;
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

  create(theme: ITheme, fontFamily: string): XtermView {
    const view = new FakeXterm();
    view.setAppearance(theme, fontFamily);
    this.created.push(view);
    return view;
  }
}
