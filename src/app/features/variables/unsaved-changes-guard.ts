import { CanDeactivateFn } from '@angular/router';

export interface LeaveGuarded {
  canLeave(): Promise<boolean>;
}

export const unsavedChangesGuard: CanDeactivateFn<LeaveGuarded> = (component) =>
  component.canLeave();
