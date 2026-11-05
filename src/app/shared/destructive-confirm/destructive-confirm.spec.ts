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
    expect(document.activeElement).toBe(cancel);
    remove.click();
    expect(completeWith).toHaveBeenCalledWith(true);
    cancel.click();
    expect(completeWith).toHaveBeenCalledWith(false);
  });

  it('shows names from files as text, never as markup', async () => {
    await TestBed.configureTestingModule({
      imports: [DestructiveConfirm],
      providers: [
        provideTaiga(),
        {
          provide: POLYMORPHEUS_CONTEXT,
          useValue: {
            data: {
              content: 'Unsaved changes in <b>a</b>.conf will be lost.',
              yes: 'Replace',
              no: 'Cancel',
            },
            completeWith: vi.fn(),
          },
        },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(DestructiveConfirm);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('b')).toBeNull();
    expect(el.textContent).toContain('Unsaved changes in <b>a</b>.conf will be lost.');
  });

  it('shows a warning variant with a primary, focused, identified confirming button', async () => {
    await TestBed.configureTestingModule({
      imports: [DestructiveConfirm],
      providers: [
        provideTaiga(),
        {
          provide: POLYMORPHEUS_CONTEXT,
          useValue: {
            data: {
              content: 'id_rsa may hold keys.',
              yes: 'Open anyway',
              no: 'Cancel',
              appearance: 'primary',
              yesTestId: 'ext-sensitive-confirm',
              warning: true,
              focusYes: true,
            },
            completeWith: vi.fn(),
          },
        },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(DestructiveConfirm);
    await fixture.whenStable();
    await new Promise((r) => setTimeout(r, 50));
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[tuiNotification]')?.textContent).toContain('id_rsa may hold keys.');
    const yes = el.querySelector<HTMLElement>('[data-testid="ext-sensitive-confirm"]')!;
    expect(yes.getAttribute('data-appearance')).toBe('primary');
    expect(document.activeElement).toBe(yes);
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

  it('shows labelled lines as a list instead of the content', async () => {
    await TestBed.configureTestingModule({
      imports: [DestructiveConfirm],
      providers: [
        provideTaiga(),
        {
          provide: POLYMORPHEUS_CONTEXT,
          useValue: {
            data: {
              content: 'a b',
              lines: ['Unsaved in Carapace: a (vps)', 'Not uploaded from your editor: b (vps)'],
              yes: 'Quit without saving',
              no: 'Cancel',
            },
            completeWith: vi.fn(),
          },
        },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(DestructiveConfirm);
    await fixture.whenStable();
    const items = [...(fixture.nativeElement as HTMLElement).querySelectorAll('ul[tuiList] li')];
    expect(items.map((li) => li.textContent?.trim())).toEqual([
      'Unsaved in Carapace: a (vps)',
      'Not uploaded from your editor: b (vps)',
    ]);
    expect((fixture.nativeElement as HTMLElement).querySelector('p')).toBeNull();
  });
});
