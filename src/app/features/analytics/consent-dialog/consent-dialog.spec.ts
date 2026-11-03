import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTaiga } from '@taiga-ui/core';
import { POLYMORPHEUS_CONTEXT } from '@taiga-ui/polymorpheus';
import { Analytics } from '../../../core/ipc/analytics';
import { ConsentDialog } from './consent-dialog';

describe('ConsentDialog', () => {
  let fixture: ComponentFixture<ConsentDialog>;
  let completeWith: ReturnType<typeof vi.fn>;
  let openPrivacyPage: ReturnType<typeof vi.fn>;

  const byId = (id: string): HTMLButtonElement =>
    (fixture.nativeElement as HTMLElement).querySelector(`[data-testid="${id}"]`)!;

  beforeEach(async () => {
    completeWith = vi.fn();
    openPrivacyPage = vi.fn().mockResolvedValue(undefined);
    await TestBed.configureTestingModule({
      imports: [ConsentDialog],
      providers: [
        provideTaiga(),
        { provide: POLYMORPHEUS_CONTEXT, useValue: { completeWith } },
        { provide: Analytics, useValue: { openPrivacyPage } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(ConsentDialog);
    await fixture.whenStable();
  });

  it('lists what is sent and what never is', () => {
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Sent');
    expect(text).toContain('Never sent');
    expect(text).toContain('Host names, addresses, ports or usernames');
  });

  it('offers two equal-weight choices, decline first', () => {
    const buttons = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('footer button'),
    );
    expect(buttons.map((b) => b.dataset['testid'])).toEqual(['consent-decline', 'consent-share']);
    expect(buttons.map((b) => b.getAttribute('data-appearance'))).toEqual([
      'secondary',
      'secondary',
    ]);
  });

  it('completes with the choice', () => {
    byId('consent-decline').click();
    byId('consent-share').click();
    expect(completeWith.mock.calls).toEqual([[false], [true]]);
  });

  it('opens the privacy page through the backend', () => {
    const link = byId('consent-privacy-link');
    expect(link.tagName).toBe('BUTTON');
    link.click();
    expect(openPrivacyPage).toHaveBeenCalledTimes(1);
  });
});
