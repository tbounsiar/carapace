import { signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTaiga } from '@taiga-ui/core';
import { POLYMORPHEUS_CONTEXT } from '@taiga-ui/polymorpheus';
import {
  Analytics,
  type AnalyticsCategory,
  type AnalyticsChoices,
} from '../../../core/ipc/analytics';
import { ConsentDialog } from './consent-dialog';

describe('ConsentDialog', () => {
  let fixture: ComponentFixture<ConsentDialog>;
  let completeWith: ReturnType<typeof vi.fn>;
  let openPrivacyPage: ReturnType<typeof vi.fn>;
  let choices: ReturnType<typeof signal<AnalyticsChoices>>;

  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const byId = <T extends HTMLElement = HTMLButtonElement>(id: string): T | null =>
    el().querySelector<T>(`[data-testid="${id}"]`);
  const sw = (id: string) => byId<HTMLInputElement>(id)!;

  async function setup(
    initial: AnalyticsChoices = { launch: true, features: true, connections: true },
    pending: readonly AnalyticsCategory[] = ['launch', 'features', 'connections'],
  ): Promise<void> {
    completeWith = vi.fn();
    openPrivacyPage = vi.fn().mockResolvedValue(undefined);
    choices = signal(initial);
    await TestBed.configureTestingModule({
      imports: [ConsentDialog],
      providers: [
        provideTaiga(),
        { provide: POLYMORPHEUS_CONTEXT, useValue: { completeWith, data: { choices, pending } } },
        { provide: Analytics, useValue: { openPrivacyPage } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(ConsentDialog);
    fixture.autoDetectChanges();
    await fixture.whenStable();
    await new Promise((r) => setTimeout(r));
    await fixture.whenStable();
  }

  it('shows the three categories as given', async () => {
    await setup({ launch: true, features: false, connections: true });
    expect(sw('consent-launch').checked).toBe(true);
    expect(sw('consent-features').checked).toBe(false);
    expect(sw('consent-connections').checked).toBe(true);
    expect(byId('consent-launch-note')?.textContent?.trim()).toBe(
      'One event when Carapace starts.',
    );
    expect(sw('consent-features').getAttribute('aria-describedby')).toBe('consent-features-note');
    expect(byId('consent-intro')?.textContent).toContain('Nothing is sent before you save.');
    expect(byId('consent-intro')?.textContent).toContain(
      "Turn off anything you don't want to share",
    );
    expect(byId('consent-common')?.querySelector('strong')?.textContent).toBe(
      'Sent with every event:',
    );
    expect(byId('consent-never')?.textContent).toContain('passwords or anything you type');
    expect(byId('consent-reask')).toBeNull();
    expect(el().querySelector('[tuiBadge]')).toBeNull();
  });

  it('starts with the focus on the launch count switch', async () => {
    await setup();
    // Taiga's default autofocus handler focuses asynchronously.
    await vi.waitFor(() => expect(document.activeElement).toBe(sw('consent-launch')));
  });

  it('writes the switches into the shared choices and saves them', async () => {
    await setup();
    sw('consent-launch').click();
    sw('consent-connections').click();
    await fixture.whenStable();
    expect(choices()).toEqual({ launch: false, features: true, connections: false });
    byId('consent-save')!.click();
    expect(completeWith).toHaveBeenCalledWith({
      launch: false,
      features: true,
      connections: false,
    });
  });

  it('has a single Save choices button', async () => {
    await setup();
    const buttons = Array.from(el().querySelectorAll<HTMLButtonElement>('footer button'));
    expect(buttons.map((b) => b.dataset['testid'])).toEqual(['consent-save']);
    expect(buttons[0].textContent?.trim()).toBe('Save choices');
    expect(byId('consent-allow-all')).toBeNull();
    expect(el().textContent).not.toContain('Allow all');
  });

  it('marks the categories asked again after a change', async () => {
    await setup({ launch: true, features: false, connections: false }, ['features']);
    expect(byId('consent-reask')?.textContent).toContain(
      'Something changed in what Carapace can send.',
    );
    const badges = Array.from(el().querySelectorAll('label')).map(
      (label) => label.querySelector('[tuiBadge]')?.textContent?.trim() ?? null,
    );
    expect(badges).toEqual([null, 'New', null]);
  });

  it('opens the privacy page through the backend', async () => {
    await setup();
    const link = byId('consent-privacy-link')!;
    expect(link.tagName).toBe('BUTTON');
    link.click();
    expect(openPrivacyPage).toHaveBeenCalledTimes(1);
  });
});
