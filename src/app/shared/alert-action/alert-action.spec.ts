import { TestBed } from '@angular/core/testing';
import { provideTaiga } from '@taiga-ui/core';
import { POLYMORPHEUS_CONTEXT } from '@taiga-ui/polymorpheus';
import { AlertAction } from './alert-action';

describe('AlertAction', () => {
  it('shows the text and runs its action, closing the toast', async () => {
    const run = vi.fn();
    const complete = vi.fn();
    await TestBed.configureTestingModule({
      imports: [AlertAction],
      providers: [
        provideTaiga(),
        {
          provide: POLYMORPHEUS_CONTEXT,
          useValue: {
            data: { text: 'Your last save was not uploaded.', action: 'Review', testId: 'x', run },
            $implicit: { complete },
          },
        },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(AlertAction);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Your last save was not uploaded.');
    const button = el.querySelector<HTMLButtonElement>('[data-testid="x"]')!;
    expect(button.textContent?.trim()).toBe('Review');
    button.click();
    expect(run).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledOnce();
  });
});
