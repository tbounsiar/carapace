import { TestBed } from '@angular/core/testing';
import { EditorFactory } from './editor-factory';

describe('EditorFactory', () => {
  it('creates a CodeMirror editor from the lazy chunk', async () => {
    const onChange = vi.fn();
    const editor = await TestBed.inject(EditorFactory).create({
      text: 'a\r\nb\n',
      language: 'json',
      readOnly: false,
      wrap: false,
      label: 'Contents of a.json',
      onChange,
      onSave: vi.fn(),
      onToggleWrap: vi.fn(),
    });
    expect(editor.element.getAttribute('data-language')).toBe('json');
    expect(editor.snapshot().text).toBe('a\nb\n');
    editor.destroy();
  });
});
