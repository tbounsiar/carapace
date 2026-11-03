import { EditorView } from '@codemirror/view';
import { createCodeEditor } from './codemirror';
import type { CodeEditorOptions, EditorStats } from './editor-factory';

describe('createCodeEditor', () => {
  let stats: EditorStats;
  const options = (extra: Partial<CodeEditorOptions> = {}): CodeEditorOptions => ({
    text: 'server {\n  listen 80;\n}\n',
    language: 'nginx',
    readOnly: false,
    wrap: false,
    label: 'Contents of nginx.conf',
    onChange: (s) => (stats = s),
    onSave: vi.fn(),
    onToggleWrap: vi.fn(),
    ...extra,
  });
  const view = (element: HTMLElement) => EditorView.findFromDOM(element)!;

  it('tracks modified against the saved text and counts UTF-8 bytes', () => {
    const editor = createCodeEditor(options({ text: 'é\n' }));
    expect(stats).toMatchObject({ modified: false, bytes: 3, lines: 2, line: 1, col: 1 });
    const v = view(editor.element);
    v.dispatch({ changes: { from: 0, insert: 'ab' } });
    expect(stats).toMatchObject({ modified: true, bytes: 5 });
    const snapshot = editor.snapshot();
    v.dispatch({ changes: { from: 0, insert: '€' } });
    editor.markSaved(snapshot);
    expect(stats.modified).toBe(true);
    v.dispatch({ changes: { from: 0, to: 1 } });
    expect(stats).toMatchObject({ modified: false, bytes: 5 });
    editor.destroy();
  });

  it('replaces the buffer as a clean state and switches language, wrap and read-only', () => {
    const editor = createCodeEditor(options());
    expect(editor.element.getAttribute('data-language')).toBe('nginx');
    expect(editor.element.getAttribute('data-testid')).toBe('editor-content');
    expect(editor.element.querySelector('.cm-content')?.getAttribute('aria-label')).toBe(
      'Contents of nginx.conf',
    );
    editor.replace('a: 1\n');
    expect(stats.modified).toBe(false);
    expect(editor.snapshot().text).toBe('a: 1\n');
    editor.setLanguage('yaml');
    expect(editor.element.getAttribute('data-language')).toBe('yaml');
    editor.setWrap(true);
    expect(editor.element.querySelector('.cm-lineWrapping')).toBeTruthy();
    editor.setReadOnly(true);
    expect(view(editor.element).state.readOnly).toBe(true);
    editor.destroy();
  });

  it('runs save on Ctrl+S', () => {
    const onSave = vi.fn();
    const editor = createCodeEditor(options({ onSave }));
    const container = document.createElement('div');
    document.body.append(container);
    editor.attach(container);
    const content = editor.element.querySelector('.cm-content')!;
    content.dispatchEvent(
      new KeyboardEvent('keydown', { key: 's', code: 'KeyS', ctrlKey: true, bubbles: true }),
    );
    expect(onSave).toHaveBeenCalled();
    editor.detach();
    expect(editor.element.isConnected).toBe(false);
    editor.destroy();
    container.remove();
  });
});
