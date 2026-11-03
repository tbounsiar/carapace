import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { json } from '@codemirror/lang-json';
import { yaml } from '@codemirror/lang-yaml';
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile';
import { nginx } from '@codemirror/legacy-modes/mode/nginx';
import { properties } from '@codemirror/legacy-modes/mode/properties';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import {
  Compartment,
  EditorState,
  Prec,
  type Extension,
  type StateEffect,
  type Text,
  Transaction,
} from '@codemirror/state';
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  type ViewUpdate,
} from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import type { CodeEditor, CodeEditorOptions, EditorSnapshot, EditorStats } from './editor-factory';
import type { LanguageId } from './language';

const LANGUAGES: Readonly<Record<LanguageId, () => Extension>> = {
  plain: () => [],
  shell: () => StreamLanguage.define(shell),
  yaml: () => yaml(),
  json: () => json(),
  ini: () => StreamLanguage.define(properties),
  nginx: () => StreamLanguage.define(nginx),
  dockerfile: () => StreamLanguage.define(dockerFile),
};

/*
 * Taiga tokens only, so the editor follows the theme switch live. Tags whose token is under 4.5:1
 * on --tui-background-base in light (--tui-status-warning, --tui-status-info) keep the text colour.
 */
const highlight = HighlightStyle.define([
  { tag: t.comment, color: 'var(--tui-text-secondary)', fontStyle: 'italic' },
  {
    tag: [t.keyword, t.heading, t.meta, t.processingInstruction, t.definitionKeyword],
    color: 'var(--tui-text-action)',
  },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--tui-text-positive)' },
  {
    tag: [t.variableName, t.special(t.variableName), t.definition(t.variableName)],
    color: 'var(--tui-text-action)',
    fontWeight: '500',
  },
]);

const theme = EditorView.theme({
  '&': {
    blockSize: '100%',
    color: 'var(--tui-text-primary)',
    backgroundColor: 'var(--tui-background-base)',
    fontSize: 'var(--app-editor-font-size, 13px)',
  },
  '&.cm-focused': { outline: '2px solid var(--tui-border-focus)', outlineOffset: '-2px' },
  '.cm-scroller': { fontFamily: 'var(--app-font-mono)', lineHeight: '1.5' },
  '.cm-content': { caretColor: 'var(--tui-text-primary)' },
  '.cm-cursor, .cm-dropCursor': { borderInlineStartColor: 'var(--tui-text-primary)' },
  '.cm-gutters': {
    backgroundColor: 'var(--tui-background-base-alt)',
    color: 'var(--tui-text-secondary)',
    border: 'none',
  },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--tui-background-neutral-1)' },
  '.cm-activeLineGutter': { color: 'var(--tui-text-primary)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground':
    { backgroundColor: 'var(--tui-status-info-pale-hover)' },
  '.cm-searchMatch': { backgroundColor: 'var(--tui-status-warning-pale)' },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'var(--tui-status-info-pale-hover)',
  },
  '.cm-selectionMatch': { backgroundColor: 'var(--tui-background-neutral-1)' },
  '.cm-panels': {
    backgroundColor: 'var(--tui-background-base-alt)',
    color: 'var(--tui-text-primary)',
  },
  '.cm-panels.cm-panels-bottom': { borderBlockStart: '1px solid var(--tui-border-normal)' },
  '.cm-panel.cm-search': { font: 'var(--tui-typography-body-s)' },
  '.cm-textfield, .cm-button': {
    color: 'var(--tui-text-primary)',
    border: '1px solid var(--tui-border-normal)',
    borderRadius: 'var(--tui-radius-s)',
  },
  '.cm-textfield': { backgroundColor: 'var(--tui-background-base)' },
  '.cm-button': {
    backgroundImage: 'none',
    backgroundColor: 'var(--tui-background-neutral-1)',
  },
  '.cm-textfield:focus-visible, .cm-button:focus-visible': {
    outline: '2px solid var(--tui-border-focus)',
  },
});

function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      // A surrogate pair is one 4-byte code point.
      bytes += 4;
      i++;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

class Snapshot implements EditorSnapshot {
  constructor(readonly doc: Text) {}

  get text(): string {
    return this.doc.toString();
  }
}

class CodeMirrorEditor implements CodeEditor {
  private readonly language = new Compartment();
  private readonly readOnly = new Compartment();
  private readonly wrap = new Compartment();
  private readonly attributes = new Compartment();
  private readonly view: EditorView;
  private saved: Text;
  private bytes: number;
  private scroll: StateEffect<unknown> | null = null;

  constructor(private readonly options: CodeEditorOptions) {
    const state = EditorState.create({
      doc: options.text,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        drawSelection(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        search({ top: false }),
        Prec.high(
          keymap.of([
            { key: 'Mod-s', preventDefault: true, run: () => (options.onSave(), true) },
            { key: 'Alt-z', preventDefault: true, run: () => (options.onToggleWrap(), true) },
          ]),
        ),
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
        syntaxHighlighting(highlight),
        theme,
        EditorView.contentAttributes.of({ 'aria-label': options.label }),
        this.attributes.of(EditorView.editorAttributes.of({ 'data-language': options.language })),
        this.language.of(LANGUAGES[options.language]()),
        this.readOnly.of(EditorState.readOnly.of(options.readOnly)),
        this.wrap.of(options.wrap ? EditorView.lineWrapping : []),
        EditorView.updateListener.of((update) => this.onUpdate(update)),
      ],
    });
    this.view = new EditorView({ state });
    this.saved = state.doc;
    this.bytes = utf8Bytes(state.doc.toString());
    this.view.dom.setAttribute('data-testid', 'editor-content');
    this.emit();
  }

  get element(): HTMLElement {
    return this.view.dom;
  }

  snapshot(): EditorSnapshot {
    return new Snapshot(this.view.state.doc);
  }

  markSaved(snapshot: EditorSnapshot): void {
    if (snapshot instanceof Snapshot) {
      this.saved = snapshot.doc;
      this.emit();
    }
  }

  replace(text: string): void {
    const { doc } = this.view.state;
    this.view.dispatch({
      changes: { from: 0, to: doc.length, insert: text },
      annotations: Transaction.addToHistory.of(false),
    });
    this.saved = this.view.state.doc;
    this.bytes = utf8Bytes(this.saved.toString());
    this.emit();
  }

  setLanguage(language: LanguageId): void {
    this.view.dispatch({
      effects: [
        this.language.reconfigure(LANGUAGES[language]()),
        this.attributes.reconfigure(EditorView.editorAttributes.of({ 'data-language': language })),
      ],
    });
  }

  setReadOnly(readOnly: boolean): void {
    this.view.dispatch({ effects: this.readOnly.reconfigure(EditorState.readOnly.of(readOnly)) });
  }

  setWrap(wrap: boolean): void {
    this.view.dispatch({
      effects: this.wrap.reconfigure(wrap ? EditorView.lineWrapping : []),
    });
  }

  attach(container: HTMLElement): void {
    if (this.view.dom.parentElement !== container) {
      container.replaceChildren(this.view.dom);
    }
    this.view.requestMeasure();
    // A detached element loses its scroll offset; the snapshot puts the same line back on top.
    if (this.scroll) {
      this.view.dispatch({ effects: this.scroll });
      this.scroll = null;
    }
  }

  detach(): void {
    if (this.view.dom.isConnected) {
      this.scroll = this.view.scrollSnapshot();
    }
    this.view.dom.remove();
  }

  focus(): void {
    this.view.focus();
  }

  destroy(): void {
    this.view.destroy();
  }

  private onUpdate(update: ViewUpdate): void {
    if (update.docChanged) {
      update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        this.bytes -= utf8Bytes(update.startState.doc.sliceString(fromA, toA));
        this.bytes += utf8Bytes(inserted.toString());
      });
    }
    if (update.docChanged || update.selectionSet) {
      this.emit();
    }
  }

  private emit(): void {
    const { state } = this.view;
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    const selected = state.selection.ranges.reduce((n, r) => n + (r.to - r.from), 0);
    const doc = state.doc;
    const stats: EditorStats = {
      line: line.number,
      col: head - line.from + 1,
      selected,
      bytes: this.bytes,
      lines: doc.lines,
      modified: !(doc.length === this.saved.length && doc.eq(this.saved)),
    };
    this.options.onChange(stats);
  }
}

export function createCodeEditor(options: CodeEditorOptions): CodeEditor {
  return new CodeMirrorEditor(options);
}
