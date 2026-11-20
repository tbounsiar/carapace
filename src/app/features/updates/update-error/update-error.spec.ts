import { TestBed } from '@angular/core/testing';
import { provideTaiga } from '@taiga-ui/core';
import { POLYMORPHEUS_CONTEXT } from '@taiga-ui/polymorpheus';
import { UpdateError, type UpdateErrorData } from './update-error';

describe('UpdateError', () => {
  async function render(data: UpdateErrorData): Promise<HTMLElement> {
    await TestBed.configureTestingModule({
      imports: [UpdateError],
      providers: [
        provideTaiga(),
        { provide: POLYMORPHEUS_CONTEXT, useValue: { data, $implicit: { complete: vi.fn() } } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(UpdateError);
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  }
  const q = (el: HTMLElement, id: string) =>
    el.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);

  it('a download error offers Retry', async () => {
    const run = vi.fn();
    const el = await render({ kind: 'download', text: 'Offline.', action: 'retry', run });
    expect(el.dataset['testid']).toBe('update-error');
    expect(el.dataset['kind']).toBe('download');
    expect(el.textContent).toContain('Offline.');
    q(el, 'update-error-retry')!.click();
    expect(run).toHaveBeenCalledOnce();
    expect(q(el, 'update-error-release-page')).toBeNull();
  });

  it('an install error offers the release page', async () => {
    const run = vi.fn();
    const el = await render({ kind: 'install', text: 'Failed.', action: 'releasePage', run });
    expect(q(el, 'update-error-release-page')!.textContent).toContain('Open release page');
    q(el, 'update-error-release-page')!.click();
    expect(run).toHaveBeenCalledOnce();
  });

  it('a refusal has no button', async () => {
    const el = await render({ kind: 'signature', text: 'Refused.', action: null, run: vi.fn() });
    expect(el.querySelector('button')).toBeNull();
  });
});
