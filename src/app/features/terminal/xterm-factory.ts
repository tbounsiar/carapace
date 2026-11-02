import { Service } from '@angular/core';
import { FitAddon } from '@xterm/addon-fit';
import { type ITheme, Terminal } from '@xterm/xterm';

/** The part of xterm the terminal sessions rely on, so specs can run without a canvas. */
export interface XtermView {
  readonly cols: number;
  readonly rows: number;
  open(parent: HTMLElement): void;
  write(data: Uint8Array | string): void;
  onData(listener: (data: string) => void): void;
  onResize(listener: (size: { cols: number; rows: number }) => void): void;
  setAppearance(theme: ITheme, fontFamily: string): void;
  fit(): void;
  focus(): void;
  dispose(): void;
}

class Xterm implements XtermView {
  private readonly fitAddon = new FitAddon();

  constructor(private readonly terminal: Terminal) {
    terminal.loadAddon(this.fitAddon);
  }

  get cols(): number {
    return this.terminal.cols;
  }

  get rows(): number {
    return this.terminal.rows;
  }

  open(parent: HTMLElement): void {
    this.terminal.open(parent);
  }

  write(data: Uint8Array | string): void {
    this.terminal.write(data);
  }

  onData(listener: (data: string) => void): void {
    this.terminal.onData(listener);
  }

  onResize(listener: (size: { cols: number; rows: number }) => void): void {
    this.terminal.onResize(listener);
  }

  setAppearance(theme: ITheme, fontFamily: string): void {
    this.terminal.options.theme = theme;
    this.terminal.options.fontFamily = fontFamily;
  }

  fit(): void {
    if (this.terminal.element?.isConnected) {
      this.fitAddon.fit();
    }
  }

  focus(): void {
    this.terminal.focus();
  }

  dispose(): void {
    this.terminal.dispose();
  }
}

@Service()
export class XtermFactory {
  create(theme: ITheme, fontFamily: string): XtermView {
    return new Xterm(
      new Terminal({
        theme,
        fontFamily,
        fontSize: 13,
        cursorBlink: true,
        scrollback: 10000,
      }),
    );
  }
}
