import { TestBed } from '@angular/core/testing';
import type { ActivatedRouteSnapshot, RouterStateSnapshot } from '@angular/router';
import { unsavedChangesGuard, type LeaveGuarded } from './unsaved-changes-guard';

describe('unsavedChangesGuard', () => {
  const run = (component: LeaveGuarded) =>
    TestBed.runInInjectionContext(() =>
      unsavedChangesGuard(
        component,
        {} as ActivatedRouteSnapshot,
        {} as RouterStateSnapshot,
        {} as RouterStateSnapshot,
      ),
    );

  it('asks the component whether it can be left', async () => {
    await expect(run({ canLeave: () => Promise.resolve(true) })).resolves.toBe(true);
    await expect(run({ canLeave: () => Promise.resolve(false) })).resolves.toBe(false);
  });
});
