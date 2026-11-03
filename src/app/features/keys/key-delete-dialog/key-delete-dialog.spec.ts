import { TestBed } from '@angular/core/testing';
import { provideTaiga } from '@taiga-ui/core';
import { POLYMORPHEUS_CONTEXT } from '@taiga-ui/polymorpheus';
import { KeyDeleteDialog, type KeyDeleteDialogData } from './key-delete-dialog';

describe('KeyDeleteDialog', () => {
  const completeWith = vi.fn();
  const complete = vi.fn();

  async function setup(managed: boolean) {
    const data: KeyDeleteDialogData = { key: { name: 'main', path: '/keys/main', managed } };
    await TestBed.configureTestingModule({
      imports: [KeyDeleteDialog],
      providers: [
        provideTaiga(),
        {
          provide: POLYMORPHEUS_CONTEXT,
          useValue: { data, completeWith, $implicit: { complete } },
        },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(KeyDeleteDialog);
    await fixture.whenStable();
    return { fixture, el: fixture.nativeElement as HTMLElement };
  }

  const button = (el: HTMLElement, text: string): HTMLButtonElement =>
    [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!;

  beforeEach(() => vi.clearAllMocks());

  it('offers to delete the files of a managed key, checked by default', async () => {
    const { el } = await setup(true);
    const box = el.querySelector<HTMLInputElement>('[data-testid="key-delete-files"]')!;
    expect(box.checked).toBe(true);
    expect(el.textContent).toContain('/keys/main');
    button(el, 'Delete').click();
    expect(completeWith).toHaveBeenCalledWith({ deleteFiles: true });
  });

  it('keeps the files when unchecked', async () => {
    const { fixture, el } = await setup(true);
    el.querySelector<HTMLInputElement>('[data-testid="key-delete-files"]')!.click();
    await fixture.whenStable();
    button(el, 'Delete').click();
    expect(completeWith).toHaveBeenCalledWith({ deleteFiles: false });
  });

  it('never deletes the file of an external key', async () => {
    const { el } = await setup(false);
    expect(el.querySelector('[data-testid="key-delete-files"]')).toBeNull();
    expect(el.textContent).toContain('The file stays at');
    button(el, 'Delete').click();
    expect(completeWith).toHaveBeenCalledWith({ deleteFiles: false });
  });

  it('cancels', async () => {
    const { el } = await setup(true);
    button(el, 'Cancel').click();
    expect(complete).toHaveBeenCalledOnce();
    expect(completeWith).not.toHaveBeenCalled();
  });
});
