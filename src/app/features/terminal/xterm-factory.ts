import { Service } from '@angular/core';
import type { FitAddon } from '@xterm/addon-fit';
import type { ITheme, Terminal } from '@xterm/xterm';

export interface XtermAppearance {
  readonly theme: ITheme;
  readonly fontFamily: string;
  readonly fontSize: number;
}

/** The part of xterm the terminal sessions rely on, so specs can run without a canvas. */
export interface XtermView {
  readonly cols: number;
  readonly rows: number;
  open(parent: HTMLElement): void;
  write(data: Uint8Array | string): void;
  onData(listener: (data: string) => void): void;
  onResize(listener: (size: { cols: number; rows: number }) => void): void;
  setAppearance(appearance: XtermAppearance): void;
  fit(): void;
  focus(): void;
  /** Keys for which `reserved` is true never reach the shell. */
  reserveKeys(reserved: (event: KeyboardEvent) => boolean): void;
  dispose(): void;
}

class Xterm implements XtermView {
  constructor(
    private readonly terminal: Terminal,
    private readonly fitAddon: FitAddon,
  ) {
    terminal.loadAddon(fitAddon);
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

  setAppearance({ theme, fontFamily, fontSize }: XtermAppearance): void {
    this.terminal.options.theme = theme;
    this.terminal.options.fontFamily = fontFamily;
    this.terminal.options.fontSize = fontSize;
  }

  fit(): void {
    if (this.terminal.element?.isConnected) {
      this.fitAddon.fit();
    }
  }

  focus(): void {
    this.terminal.focus();
  }

  reserveKeys(reserved: (event: KeyboardEvent) => boolean): void {
    this.terminal.attachCustomKeyEventHandler((event) => !reserved(event));
  }

  dispose(): void {
    this.terminal.dispose();
  }
}

type XtermModules = [typeof import('@xterm/xterm'), typeof import('@xterm/addon-fit')];

/** xterm is loaded on the first terminal, so it stays out of the host page and initial bundles. */
@Service()
export class XtermFactory {
  private modules: Promise<XtermModules> | null = null;

  async create({ theme, fontFamily, fontSize }: XtermAppearance): Promise<XtermView> {
    const [{ Terminal }, { FitAddon }] = await this.load();
    return new Xterm(
      new Terminal({
        theme,
        fontFamily,
        fontSize,
        cursorBlink: true,
        scrollback: 10000,
        // Without a handler xterm opens OSC 8 links chosen by the server with window.open.
        linkHandler: { activate: () => undefined },
      }),
      new FitAddon(),
    );
  }

  private load(): Promise<XtermModules> {
    if (!this.modules) {
      const modules = Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]);
      // A failed chunk load may succeed on the next terminal.
      modules.catch(() => {
        this.modules = null;
      });
      this.modules = modules;
    }
    return this.modules;
  }
}
