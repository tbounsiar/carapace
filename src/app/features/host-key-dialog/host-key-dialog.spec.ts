import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTaiga, TuiRoot } from '@taiga-ui/core';
import type { HostKeyChanged, HostKeyPrompt } from '../../core/ipc/ssh.models';
import { HostKeyPrompter } from './host-key-prompter';

@Component({ imports: [TuiRoot], template: '<tui-root />' })
class Shell {}

const unknown: HostKeyPrompt = {
  kind: 'hostKeyPrompt',
  requestId: 'r1',
  status: 'unknown',
  hostname: 'web.example',
  port: 2222,
  algorithm: 'ssh-ed25519',
  fingerprint: 'SHA256:newfingerprint',
};
const changed: HostKeyChanged = {
  kind: 'hostKeyChanged',
  hostname: 'web.example',
  port: 2222,
  algorithm: 'ssh-ed25519',
  fingerprint: 'SHA256:newfingerprint',
  knownFingerprints: ['SHA256:old1', 'SHA256:old2'],
};

describe('host key dialogs', () => {
  let fixture: ComponentFixture<Shell>;
  let prompter: HostKeyPrompter;

  const settle = async (): Promise<void> => {
    await fixture.whenStable();
    await new Promise((r) => setTimeout(r));
    await fixture.whenStable();
  };
  const dialog = (selector: string): HTMLElement => document.body.querySelector(selector)!;
  const button = (selector: string, text: string): HTMLButtonElement =>
    Array.from(dialog(selector).querySelectorAll('button')).find((b) =>
      b.textContent?.includes(text),
    )!;
  const closeWithEscape = (selector: string): void => {
    dialog(selector).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  };
  const closeWithCross = (): void => {
    document.body.querySelector<HTMLElement>('tui-dialog [tuiIconButton]')?.click();
  };

  beforeEach(async () => {
    // The prompter imports the dialog lazily; load it once so a single settle() is enough.
    await Promise.all([
      import('./host-key-dialog'),
      import('./host-key-changed-dialog/host-key-changed-dialog'),
    ]);
    await TestBed.configureTestingModule({
      imports: [Shell],
      providers: [provideTaiga()],
    }).compileComponents();
    fixture = TestBed.createComponent(Shell);
    prompter = TestBed.inject(HostKeyPrompter);
    await settle();
  });

  describe('unknown key', () => {
    const sel = 'app-host-key-dialog';

    it('shows host, algorithm and fingerprint, and has no bypass option', async () => {
      void prompter.ask(unknown);
      await settle();
      const text = dialog(sel).textContent ?? '';
      expect(text).toContain('web.example:2222');
      expect(text).toContain('ssh-ed25519');
      expect(dialog(sel).querySelector('[data-testid="fingerprint"]')?.textContent).toContain(
        'SHA256:newfingerprint',
      );
      expect(dialog(sel).querySelectorAll('button').length).toBe(2);
    });

    it('resolves true on accept', async () => {
      const result = prompter.ask(unknown);
      await settle();
      button(sel, 'Accept and connect').click();
      await settle();
      expect(await result).toBe(true);
    });

    it('resolves false on reject', async () => {
      const result = prompter.ask(unknown);
      await settle();
      button(sel, 'Reject').click();
      await settle();
      expect(await result).toBe(false);
    });

    it('resolves false when closed with Escape', async () => {
      const result = prompter.ask(unknown);
      await settle();
      closeWithEscape(sel);
      await settle();
      expect(await result).toBe(false);
    });

    it('resolves false when closed with the close button', async () => {
      const result = prompter.ask(unknown);
      await settle();
      closeWithCross();
      await settle();
      expect(await result).toBe(false);
    });
  });

  describe('changed key', () => {
    const sel = 'app-host-key-changed-dialog';

    it('warns and shows known and presented fingerprints', async () => {
      void prompter.confirmReplace(changed);
      await settle();
      expect(dialog(sel).querySelector('[tuiNotification]')).not.toBeNull();
      const known = dialog(sel).querySelector('[data-testid="known"]')?.textContent ?? '';
      expect(known).toContain('SHA256:old1');
      expect(known).toContain('SHA256:old2');
      expect(dialog(sel).querySelector('[data-testid="presented"]')?.textContent).toContain(
        'SHA256:newfingerprint',
      );
    });

    it('resolves false on Close', async () => {
      const result = prompter.confirmReplace(changed);
      await settle();
      button(sel, 'Close').click();
      await settle();
      expect(await result).toBe(false);
    });

    it('resolves false on Escape and on the close button', async () => {
      const first = prompter.confirmReplace(changed);
      await settle();
      closeWithEscape(sel);
      await settle();
      expect(await first).toBe(false);

      const second = prompter.confirmReplace(changed);
      await settle();
      closeWithCross();
      await settle();
      expect(await second).toBe(false);
    });

    it('resolves true only on Replace stored key', async () => {
      const result = prompter.confirmReplace(changed);
      await settle();
      button(sel, 'Replace stored key').click();
      await settle();
      expect(await result).toBe(true);
    });
  });
});
