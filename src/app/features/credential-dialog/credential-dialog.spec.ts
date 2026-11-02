import { TestBed } from '@angular/core/testing';
import type { FormGroup } from '@angular/forms';
import { provideTaiga } from '@taiga-ui/core';
import { POLYMORPHEUS_CONTEXT } from '@taiga-ui/polymorpheus';
import { CredentialDialog, type CredentialDialogData } from './credential-dialog';

interface DialogApi {
  form: FormGroup;
  submit(): void;
}

describe('CredentialDialog', () => {
  const completeWith = vi.fn();
  const complete = vi.fn();

  async function setup(
    data: CredentialDialogData = { kind: 'password', subject: 'deploy@web:22', error: null },
  ) {
    await TestBed.configureTestingModule({
      imports: [CredentialDialog],
      providers: [
        provideTaiga(),
        {
          provide: POLYMORPHEUS_CONTEXT,
          useValue: { data, completeWith, $implicit: { complete } },
        },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(CredentialDialog);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    return { fixture, el, dialog: fixture.componentInstance as unknown as DialogApi };
  }

  const byId = <T extends HTMLElement>(el: HTMLElement, id: string): T =>
    el.querySelector<T>(`[data-testid="${id}"]`)!;

  beforeEach(() => vi.clearAllMocks());

  it('renders a password input with remember unchecked by default', async () => {
    const { el, dialog } = await setup();
    expect(byId<HTMLInputElement>(el, 'credential-secret').type).toBe('password');
    expect(byId<HTMLInputElement>(el, 'credential-remember').checked).toBe(false);
    expect(dialog.form.getRawValue()).toEqual({ secret: '', remember: false });
    expect(byId(el, 'credential-error')).toBeNull();
  });

  it('shows the error line when given', async () => {
    const { el } = await setup({
      kind: 'passphrase',
      subject: '~/.ssh/id',
      error: 'Wrong passphrase',
    });
    expect(byId(el, 'credential-error').textContent).toContain('Wrong passphrase');
    expect(el.textContent).toContain('Passphrase');
  });

  it('requires a value', async () => {
    const { dialog } = await setup();
    dialog.submit();
    expect(completeWith).not.toHaveBeenCalled();
  });

  it('completes with the credential and clears the form', async () => {
    const { dialog } = await setup();
    dialog.form.setValue({ secret: 's3cret', remember: true });
    dialog.submit();
    expect(completeWith).toHaveBeenCalledWith({ secret: 's3cret', remember: true });
    expect(dialog.form.getRawValue()).toEqual({ secret: '', remember: false });
  });

  it('cancels without a credential', async () => {
    const { el } = await setup();
    byId<HTMLButtonElement>(el, 'credential-cancel').click();
    expect(complete).toHaveBeenCalledOnce();
    expect(completeWith).not.toHaveBeenCalled();
  });
});
