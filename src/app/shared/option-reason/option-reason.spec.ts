import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TuiDataList } from '@taiga-ui/core';
import { OptionLabel } from './option-label';
import { OptionReason } from './option-reason';

@Component({
  imports: [OptionLabel, OptionReason, TuiDataList],
  template: `
    <tui-data-list>
      <button tuiOption type="button" [appOptionReason]="reason()" (click)="clicks = clicks + 1">
        <app-option-label>Upload now</app-option-label>
      </button>
    </tui-data-list>
  `,
})
class Host {
  readonly reason = signal<string | null>('No changes to upload');
  clicks = 0;
}

describe('OptionReason', () => {
  function setup() {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const option = fixture.nativeElement.querySelector('button') as HTMLButtonElement;
    return { fixture, option };
  }

  it('keeps an unavailable option enabled, announced as disabled, and ignores clicks', () => {
    const { fixture, option } = setup();
    expect(option.disabled).toBe(false);
    expect(option.getAttribute('aria-disabled')).toBe('true');
    option.click();
    expect(fixture.componentInstance.clicks).toBe(0);
  });

  it('dims the label only and shows the reason as a subtitle', () => {
    const { option } = setup();
    const label = option.querySelector('[tuiAppearance]');
    expect(label?.textContent?.trim()).toBe('Upload now');
    expect(label?.getAttribute('data-state')).toBe('disabled');
    const reason = option.querySelector('[tuiSubtitle]');
    expect(reason?.textContent).toBe('No changes to upload');
    expect(reason?.closest('[data-state]')).toBeNull();
  });

  it('acts as a plain option without a reason', () => {
    const { fixture, option } = setup();
    fixture.componentInstance.reason.set(null);
    fixture.detectChanges();
    expect(option.hasAttribute('aria-disabled')).toBe(false);
    expect(option.textContent?.trim()).toBe('Upload now');
    expect(option.querySelector('[tuiSubtitle]')).toBeNull();
    option.click();
    expect(fixture.componentInstance.clicks).toBe(1);
  });
});
