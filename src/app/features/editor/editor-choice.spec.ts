import { of } from 'rxjs';
import type { TuiDialogService } from '@taiga-ui/core';
import { askEditorChoice } from './editor-choice';
import type { EditorChoiceData } from './editor-choice-dialog/editor-choice-dialog';

describe('askEditorChoice', () => {
  beforeAll(() => import('./editor-choice-dialog/editor-choice-dialog'), 60_000);

  it('escapes the file name in the label, which Taiga renders as HTML', async () => {
    const open = vi.fn(() => of('save'));
    const choice = await askEditorChoice({ open } as unknown as TuiDialogService, {
      kind: 'unsaved',
      name: '<i>nginx</i>.conf',
      host: 'web',
    } satisfies EditorChoiceData);
    expect(choice).toBe('save');
    const options = (open.mock.calls[0] as unknown[])[1] as { label: string };
    expect(options.label).toBe('Save changes to &lt;i&gt;nginx&lt;/i&gt;.conf?');
  });
});
