import { Component, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { ContextMenuTarget } from './context-menu-target';

@Component({
  imports: [ContextMenuTarget],
  template: `<div
    #target="appContextMenuTarget"
    class="list"
    [appContextMenuTarget]="mode()"
    (contextTarget)="rows.push($event)"
    (contextmenu)="opened.push($event)"
    [attr.data-align]="target.align()"
  >
    <span class="off">header</span>
    <p data-menu-row="r1"><button type="button">…</button></p>
  </div>`,
})
class Host {
  readonly mode = signal<'rows' | ''>('');
  readonly rows: (HTMLElement | null)[] = [];
  readonly opened: Event[] = [];
}

describe('ContextMenuTarget', () => {
  let fixture: ComponentFixture<Host>;
  const el = (selector: string): HTMLElement =>
    (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>(selector)!;
  const rightClick = (target: Element, clientX = 10): MouseEvent => {
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX });
    target.dispatchEvent(event);
    fixture.detectChanges();
    return event;
  };

  beforeEach(() => {
    fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
  });

  it('reports the row under the pointer before the menu opens', () => {
    rightClick(el('button'));
    const host = fixture.componentInstance;
    expect(host.rows).toEqual([el('[data-menu-row]')]);
    expect(host.opened.length).toBe(1);
  });

  it('reports null off the rows by default', () => {
    rightClick(el('.off'));
    expect(fixture.componentInstance.rows).toEqual([null]);
    expect(fixture.componentInstance.opened.length).toBe(1);
  });

  it('opens nothing off the rows in rows mode and cancels the page menu', () => {
    fixture.componentInstance.mode.set('rows');
    fixture.detectChanges();
    const event = rightClick(el('.off'));
    expect(event.defaultPrevented).toBe(true);
    expect(fixture.componentInstance.rows).toEqual([]);
    expect(fixture.componentInstance.opened).toEqual([]);
  });

  it('grows the menu leftwards near the right edge of the window', () => {
    rightClick(el('button'), 10);
    expect(el('.list').getAttribute('data-align')).toBe('start');
    rightClick(el('button'), window.innerWidth - 20);
    expect(el('.list').getAttribute('data-align')).toBe('end');
  });
});
