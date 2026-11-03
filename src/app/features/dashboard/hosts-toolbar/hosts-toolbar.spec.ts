import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTaiga, TuiRoot } from '@taiga-ui/core';
import { HostsToolbar } from './hosts-toolbar';

const query = signal('');
const connectedOnly = signal(false);
const count = signal<string | null>(null);
let submitted = 0;

@Component({
  imports: [HostsToolbar, TuiRoot],
  template: `<tui-root>
    <app-hosts-toolbar
      [count]="count()"
      [(query)]="query"
      [(connectedOnly)]="connectedOnly"
      (submitted)="onSubmit()"
    />
  </tui-root>`,
})
class Shell {
  protected readonly query = query;
  protected readonly connectedOnly = connectedOnly;
  protected readonly count = count;
  protected onSubmit(): void {
    submitted++;
  }
}

describe('HostsToolbar', () => {
  let fixture: ComponentFixture<Shell>;
  const byId = <T extends HTMLElement = HTMLElement>(id: string): T | null =>
    document.body.querySelector<T>(`[data-testid="${id}"]`);
  const search = () => byId<HTMLInputElement>('hosts-search')!;
  const settle = async () => {
    await fixture.whenStable();
    await new Promise((r) => setTimeout(r));
    await fixture.whenStable();
  };
  const key = (target: EventTarget, k: string, init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', {
      key: k,
      bubbles: true,
      cancelable: true,
      ...init,
    });
    target.dispatchEvent(event);
    return event;
  };

  beforeEach(async () => {
    query.set('');
    connectedOnly.set(false);
    count.set(null);
    submitted = 0;
    await TestBed.configureTestingModule({
      imports: [Shell],
      providers: [provideTaiga()],
    }).compileComponents();
    fixture = TestBed.createComponent(Shell);
    await settle();
  });

  it('binds the search, clears it with Escape and submits with Enter', async () => {
    expect(search().getAttribute('aria-label')).toBe('Search hosts');
    search().value = 'api';
    search().dispatchEvent(new Event('input'));
    await settle();
    expect(query()).toBe('api');
    key(search(), 'Enter');
    expect(submitted).toBe(1);
    expect(key(search(), 'Escape').defaultPrevented).toBe(true);
    await settle();
    expect(query()).toBe('');
    expect(search().value).toBe('');
  });

  it('switches between All and Connected, and follows the bound value', async () => {
    const all = byId<HTMLInputElement>('hosts-filter-all')!;
    const connected = byId<HTMLInputElement>('hosts-filter-connected')!;
    expect(all.checked).toBe(true);
    connected.click();
    await settle();
    expect(connectedOnly()).toBe(true);
    connectedOnly.set(false);
    await settle();
    expect(all.checked).toBe(true);
    const items = document.body.querySelectorAll('tui-segmented > label');
    expect(items[0].classList).toContain('tui-segmented_active');
  });

  it('shows the count only when given', async () => {
    expect(byId('hosts-count')).toBeNull();
    count.set('5 of 12 hosts');
    await settle();
    expect(byId('hosts-count')?.textContent).toBe('5 of 12 hosts');
    expect(byId('hosts-count')?.getAttribute('role')).toBe('status');
  });

  it('takes the focus with Ctrl+F', () => {
    expect(key(document.body, 'f', { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(search());
  });
});
