import { TestBed } from '@angular/core/testing';
import { provideTaiga } from '@taiga-ui/core';
import { POLYMORPHEUS_CONTEXT } from '@taiga-ui/polymorpheus';
import { ExternalNoticeDialog } from './external-notice-dialog';

describe('ExternalNoticeDialog', () => {
  async function render() {
    const completeWith = vi.fn();
    const complete = vi.fn();
    await TestBed.configureTestingModule({
      imports: [ExternalNoticeDialog],
      providers: [
        provideTaiga(),
        { provide: POLYMORPHEUS_CONTEXT, useValue: { completeWith, $implicit: { complete } } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(ExternalNoticeDialog);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const byId = <T extends HTMLElement>(id: string) =>
      el.querySelector<T>(`[data-testid="${id}"]`)!;
    return { fixture, el, byId, completeWith, complete };
  }

  it('explains the local copy and continues with the checkbox unchecked by default', async () => {
    const { el, byId, completeWith } = await render();
    expect(el.textContent).toContain('Carapace downloads a copy of the file to this computer');
    expect(byId<HTMLInputElement>('ext-notice-dont-show').checked).toBe(false);
    expect(byId('ext-notice-continue').hasAttribute('tuiAutoFocus')).toBe(true);
    byId('ext-notice-continue').click();
    expect(completeWith).toHaveBeenCalledWith({ dontShow: false });
  });

  it('answers dontShow when ticked, and nothing on Cancel', async () => {
    const { fixture, byId, completeWith, complete } = await render();
    byId<HTMLInputElement>('ext-notice-dont-show').click();
    await fixture.whenStable();
    byId('ext-notice-continue').click();
    expect(completeWith).toHaveBeenCalledWith({ dontShow: true });
    byId('ext-notice-cancel').click();
    expect(complete).toHaveBeenCalled();
  });
});
