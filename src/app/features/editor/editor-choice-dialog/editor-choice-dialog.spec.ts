import { TestBed } from '@angular/core/testing';
import { provideTaiga } from '@taiga-ui/core';
import { POLYMORPHEUS_CONTEXT } from '@taiga-ui/polymorpheus';
import { of } from 'rxjs';
import { askEditorChoice } from '../editor-choice';
import { type EditorChoiceData, EditorChoiceDialog } from './editor-choice-dialog';

describe('EditorChoiceDialog', () => {
  async function render(data: EditorChoiceData) {
    const completeWith = vi.fn();
    TestBed.configureTestingModule({
      imports: [EditorChoiceDialog],
      providers: [
        provideTaiga(),
        { provide: POLYMORPHEUS_CONTEXT, useValue: { data, completeWith } },
      ],
    });
    const fixture = TestBed.createComponent(EditorChoiceDialog);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const button = (id: string) => el.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
    return { el, completeWith, button };
  }

  it('offers Save (focused), Don’t save and Cancel for unsaved changes', async () => {
    const { el, completeWith, button } = await render({
      kind: 'unsaved',
      name: 'nginx.conf',
      host: 'vps',
    });
    expect(el.textContent).toContain('Your changes are lost if you don’t save them.');
    expect(button('unsaved-save')?.hasAttribute('tuiAutoFocus')).toBe(true);
    expect(button('unsaved-save')?.getAttribute('data-appearance')).toBe('primary');
    expect(button('unsaved-discard')?.getAttribute('data-appearance')).toBe('flat-destructive');
    button('unsaved-discard')?.click();
    expect(completeWith).toHaveBeenCalledWith('discard');
    button('unsaved-cancel')?.click();
    expect(completeWith).toHaveBeenCalledWith('cancel');
  });

  it('warns about a server change with Cancel focused', async () => {
    const { el, completeWith, button } = await render({
      kind: 'changed',
      name: 'nginx.conf',
      host: 'vps',
    });
    expect(el.textContent).toContain('nginx.conf was modified on vps after you opened it.');
    expect(button('conflict-edit-cancel')?.hasAttribute('tuiAutoFocus')).toBe(true);
    button('conflict-edit-overwrite')?.click();
    expect(completeWith).toHaveBeenCalledWith('overwrite');
    button('conflict-edit-reload')?.click();
    expect(completeWith).toHaveBeenCalledWith('reload');
  });

  it('offers Save anyway when the file was deleted', async () => {
    const { el, completeWith, button } = await render({ kind: 'deleted', name: 'a', host: 'vps' });
    expect(el.textContent).toContain('a no longer exists on vps.');
    expect(button('conflict-edit-overwrite')).toBeNull();
    button('conflict-edit-save-anyway')?.click();
    expect(completeWith).toHaveBeenCalledWith('saveAnyway');
  });

  it('offers only Reload or Keep editing when a link points elsewhere', async () => {
    const { el, completeWith, button } = await render({
      kind: 'retargeted',
      name: 'a',
      host: 'vps',
    });
    expect(el.textContent).toContain('a now points to another file on vps.');
    expect(button('conflict-edit-overwrite')).toBeNull();
    expect(button('conflict-edit-save-anyway')).toBeNull();
    expect(button('conflict-edit-cancel')?.textContent).toContain('Keep editing');
    button('conflict-edit-reload')?.click();
    expect(completeWith).toHaveBeenCalledWith('reload');
  });

  it('offers the external variant: Overwrite server, Use server version, Keep my copy', async () => {
    const { el, completeWith, button } = await render({
      kind: 'externalChanged',
      name: 'nginx.conf',
      host: 'vps',
    });
    expect(el.textContent).toContain('nginx.conf was modified on vps after your last upload.');
    expect(el.textContent).toContain('Your local copy has changes that are not on the server.');
    expect(button('conflict-ext-keep')?.hasAttribute('tuiAutoFocus')).toBe(true);
    expect(button('conflict-ext-keep')?.textContent).toContain('Keep my copy');
    expect(button('conflict-ext-server')?.getAttribute('data-appearance')).toBe('flat-destructive');
    button('conflict-ext-overwrite')?.click();
    expect(completeWith).toHaveBeenCalledWith('overwrite');
    button('conflict-ext-server')?.click();
    expect(completeWith).toHaveBeenCalledWith('useServer');
    button('conflict-ext-keep')?.click();
    expect(completeWith).toHaveBeenCalledWith('cancel');
  });

  it('offers Upload anyway and Stop editing when the server file was deleted', async () => {
    const { el, completeWith, button } = await render({
      kind: 'externalDeleted',
      name: 'nginx.conf',
      host: 'vps',
    });
    expect(el.textContent).toContain('nginx.conf no longer exists on vps.');
    expect(button('conflict-ext-server')).toBeNull();
    button('conflict-ext-upload-anyway')?.click();
    expect(completeWith).toHaveBeenCalledWith('overwrite');
    button('conflict-ext-stop')?.click();
    expect(completeWith).toHaveBeenCalledWith('stop');
  });

  it('answers cancel when the dialog closes without a choice', async () => {
    const dialogs = { open: vi.fn(() => of()) };
    await expect(
      askEditorChoice(dialogs as never, { kind: 'unsaved', name: 'a', host: 'b' }),
    ).resolves.toBe('cancel');
    expect(dialogs.open).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ label: 'Save changes to a?' }),
    );
  });
});
