import { TestBed } from '@angular/core/testing';
import { SidebarState } from './sidebar-state';

describe('SidebarState', () => {
  beforeEach(() => localStorage.clear());

  it('persists the expanded collections', () => {
    const state = TestBed.inject(SidebarState);
    state.setOpen('c1', true);
    state.expand(['c2', 'c1']);
    expect(state.isOpen('c2')).toBe(true);
    state.setOpen('c1', false);
    expect(JSON.parse(localStorage.getItem('carapace.expanded')!)).toEqual(['c2']);

    TestBed.resetTestingModule();
    expect(TestBed.inject(SidebarState).isOpen('c2')).toBe(true);
  });

  it('ignores a broken stored value', () => {
    localStorage.setItem('carapace.expanded', '{oops');
    expect(TestBed.inject(SidebarState).expanded().size).toBe(0);
  });

  it('holds one focus request at a time', () => {
    const state = TestBed.inject(SidebarState);
    state.focus('a');
    state.focus('b');
    expect(state.focusRequest()).toBe('b');
    state.focusDone();
    expect(state.focusRequest()).toBeNull();
  });
});
