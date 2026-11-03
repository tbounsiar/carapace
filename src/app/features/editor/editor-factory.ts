import { Service } from '@angular/core';
import type { LanguageId } from './language';

export interface EditorStats {
  /** 1-based. */
  readonly line: number;
  readonly col: number;
  readonly selected: number;
  /** UTF-8 bytes of the text with `\n` line breaks. */
  readonly bytes: number;
  readonly lines: number;
  readonly modified: boolean;
}

/** The text at one moment, kept to mark exactly that text saved once its save succeeds. */
export interface EditorSnapshot {
  readonly text: string;
}

export interface CodeEditorOptions {
  /** Line breaks may be `\n`, `\r\n` or mixed; the editor keeps `\n`. */
  readonly text: string;
  readonly language: LanguageId;
  readonly readOnly: boolean;
  readonly wrap: boolean;
  /** Accessible name of the text area, "Contents of nginx.conf". */
  readonly label: string;
  readonly onChange: (stats: EditorStats) => void;
  readonly onSave: () => void;
  readonly onToggleWrap: () => void;
}

/** The part of CodeMirror the editor tabs rely on, so specs run without it. */
export interface CodeEditor {
  readonly element: HTMLElement;
  snapshot(): EditorSnapshot;
  /** Makes `snapshot` the clean state: the buffer is modified while it differs from it. */
  markSaved(snapshot: EditorSnapshot): void;
  /** Replaces the whole buffer and makes it the clean state (reload from the server). */
  replace(text: string): void;
  setLanguage(language: LanguageId): void;
  setReadOnly(readOnly: boolean): void;
  setWrap(wrap: boolean): void;
  attach(container: HTMLElement): void;
  detach(): void;
  focus(): void;
  destroy(): void;
}

type CodeMirrorModule = typeof import('./codemirror');

/** CodeMirror and its languages are one lazy chunk, loaded by the first editor tab. */
@Service()
export class EditorFactory {
  private module: Promise<CodeMirrorModule> | null = null;

  async create(options: CodeEditorOptions): Promise<CodeEditor> {
    const { createCodeEditor } = await this.load();
    return createCodeEditor(options);
  }

  private load(): Promise<CodeMirrorModule> {
    if (!this.module) {
      const module = import('./codemirror');
      // A failed chunk load may succeed on the next file.
      module.catch(() => {
        this.module = null;
      });
      this.module = module;
    }
    return this.module;
  }
}
