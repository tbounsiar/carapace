import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTaiga, TuiRoot } from '@taiga-ui/core';
import { CredentialPrompter } from './credential-prompter';

@Component({ imports: [TuiRoot], template: '<tui-root />' })
class Shell {}

describe('CredentialPrompter', () => {
  let fixture: ComponentFixture<Shell>;
  let prompter: CredentialPrompter;

  const settle = async (): Promise<void> => {
    await fixture.whenStable();
    await new Promise((r) => setTimeout(r));
    await fixture.whenStable();
  };
  const byId = <T extends HTMLElement>(id: string): T =>
    document.body.querySelector<T>(`app-credential-dialog [data-testid="${id}"]`)!;

  // The prompter imports the dialog lazily; load it once so a single settle() is enough. The
  // cold import can exceed the default hook timeout on a busy machine.
  beforeAll(() => import('./credential-dialog'), 60_000);

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Shell],
      providers: [provideTaiga()],
    }).compileComponents();
    fixture = TestBed.createComponent(Shell);
    prompter = TestBed.inject(CredentialPrompter);
    await settle();
  });

  it('shows the label as title and resolves the submitted credential', async () => {
    const result = prompter.ask('Password for deploy@web', {
      kind: 'password',
      subject: 'deploy@web:22',
      error: null,
    });
    await settle();
    expect(document.body.querySelector('tui-dialog')?.textContent).toContain(
      'Password for deploy@web',
    );
    const input = byId<HTMLInputElement>('credential-secret');
    input.value = 'pw';
    input.dispatchEvent(new Event('input'));
    byId<HTMLButtonElement>('credential-submit').click();
    await settle();
    expect(await result).toEqual({ secret: 'pw', remember: false });
  });

  it('resolves null on cancel and on Escape', async () => {
    const first = prompter.ask('t', { kind: 'password', subject: 'deploy@web:22', error: null });
    await settle();
    byId<HTMLButtonElement>('credential-cancel').click();
    await settle();
    expect(await first).toBeNull();

    const second = prompter.ask('t', { kind: 'passphrase', subject: '~/.ssh/id', error: null });
    await settle();
    document.body
      .querySelector('app-credential-dialog')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    expect(await second).toBeNull();
  });
});
