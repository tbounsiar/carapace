import { TestBed } from '@angular/core/testing';
import type { UpdateState } from '../../core/ipc/updates';
import { UpdateStore } from './update-store';

const STATE: UpdateState = {
  current: '0.2.0',
  autoCheck: true,
  skippedVersion: null,
  lastCheck: null,
  available: null,
  downloaded: false,
  installKind: 'inPlace',
};

describe('UpdateStore', () => {
  let store: UpdateStore;

  beforeEach(() => {
    store = TestBed.inject(UpdateStore);
    store.state.set(STATE);
  });

  it('shows the badge for an offer that is not skipped', () => {
    expect(store.badge()).toBe(false);
    store.offer.set({ version: '0.3.0', date: null });
    store.phase.set('available');
    expect(store.badge()).toBe(true);
    store.state.set({ ...STATE, skippedVersion: '0.3.0' });
    expect(store.skipped()).toBe(true);
    expect(store.badge()).toBe(false);
  });

  it('shows the badge while ready, even for a skipped version', () => {
    store.state.set({ ...STATE, skippedVersion: '0.3.0' });
    store.offer.set({ version: '0.3.0', date: null });
    store.phase.set('ready');
    expect(store.badge()).toBe(true);
  });

  it('is busy while downloading, verifying or installing', () => {
    for (const phase of ['downloading', 'verifying', 'installing'] as const) {
      store.phase.set(phase);
      expect(store.busy()).toBe(true);
    }
    for (const phase of ['available', 'ready', null] as const) {
      store.phase.set(phase);
      expect(store.busy()).toBe(false);
    }
  });

  it('reads the install kind', () => {
    expect(store.downloadOnly()).toBe(false);
    store.state.set({ ...STATE, installKind: 'downloadOnly' });
    expect(store.downloadOnly()).toBe(true);
  });
});
