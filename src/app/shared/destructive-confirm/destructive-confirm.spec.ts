import { TestBed } from '@angular/core/testing';
import { provideTaiga } from '@taiga-ui/core';
import { POLYMORPHEUS_CONTEXT } from '@taiga-ui/polymorpheus';
import { of } from 'rxjs';
import { confirmDestructive } from './confirm-destructive';
import { DestructiveConfirm } from './destructive-confirm';

describe('DestructiveConfirm', () => {
  it('focuses Cancel, paints the destructive button and answers', async () => {
    const completeWith = vi.fn();
    await TestBed.configureTestingModule({
      imports: [DestructiveConfirm],
      providers: [
        provideTaiga(),
        {
          provide: POLYMORPHEUS_CONTEXT,
          useValue: {
            data: { content: '“ui” is empty.', yes: 'Delete', no: 'Cancel' },
            completeWith,
          },
        },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(DestructiveConfirm);
    await fixture.whenStable();
    await new Promise((r) => setTimeout(r, 50));
    const el = fixture.nativeElement as HTMLElement;
    const [cancel, remove] = [...el.querySelectorAll('button')];
    expect(el.textContent).toContain('“ui” is empty.');
    expect(cancel.getAttribute('data-appearance')).toBe('flat');
    expect(remove.getAttribute('data-appearance')).toBe('primary-destructive');
    expect(cancel.hasAttribute('tuiAutoFocus')).toBe(true);
    remove.click();
    expect(completeWith).toHaveBeenCalledWith(true);
    cancel.click();
    expect(completeWith).toHaveBeenCalledWith(false);
  });

  it('resolves false when the dialog closes without an answer', async () => {
    const dialogs = { open: vi.fn(() => of()) };
    await expect(
      confirmDestructive(dialogs as never, 'Delete host?', {
        content: 'x',
        yes: 'Delete',
        no: 'Cancel',
      }),
    ).resolves.toBe(false);
  });
});
