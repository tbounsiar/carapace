import type {
  CodeEditor,
  CodeEditorOptions,
  EditorFactory,
  EditorSnapshot,
  EditorStats,
} from './editor-factory';
import type { LanguageId } from './language';

/** Test double for CodeMirror: a plain string buffer. */
export class FakeEditor implements CodeEditor {
  readonly element = document.createElement('div');
  text: string;
  saved: string;
  language: LanguageId;
  readOnly: boolean;
  wrap: boolean;
  focused = 0;
  destroyed = false;

  constructor(readonly options: CodeEditorOptions) {
    this.text = options.text.replace(/\r\n/g, '\n');
    this.saved = this.text;
    this.language = options.language;
    this.readOnly = options.readOnly;
    this.wrap = options.wrap;
    this.element.setAttribute('data-testid', 'editor-content');
    this.emit();
  }

  /** What typing does: the buffer changes and listeners hear about it. */
  type(text: string): void {
    if (!this.readOnly) {
      this.text = text;
      this.emit();
    }
  }

  snapshot(): EditorSnapshot {
    return { text: this.text };
  }

  markSaved(snapshot: EditorSnapshot): void {
    this.saved = snapshot.text;
    this.emit();
  }

  replace(text: string): void {
    this.text = text.replace(/\r\n/g, '\n');
    this.saved = this.text;
    this.emit();
  }

  setLanguage(language: LanguageId): void {
    this.language = language;
  }

  setReadOnly(readOnly: boolean): void {
    this.readOnly = readOnly;
  }

  setWrap(wrap: boolean): void {
    this.wrap = wrap;
  }

  attach(container: HTMLElement): void {
    container.replaceChildren(this.element);
  }

  detach(): void {
    this.element.remove();
  }

  focus(): void {
    this.focused++;
  }

  destroy(): void {
    this.destroyed = true;
  }

  private emit(): void {
    const stats: EditorStats = {
      line: 1,
      col: 1,
      selected: 0,
      bytes: new TextEncoder().encode(this.text).length,
      lines: this.text.split('\n').length,
      modified: this.text !== this.saved,
    };
    this.options.onChange(stats);
  }
}

export class FakeEditorFactory implements Pick<EditorFactory, 'create'> {
  readonly created: FakeEditor[] = [];
  fail = false;

  create(options: CodeEditorOptions): Promise<CodeEditor> {
    if (this.fail) {
      return Promise.reject(new Error('chunk'));
    }
    const editor = new FakeEditor(options);
    this.created.push(editor);
    return Promise.resolve(editor);
  }
}
