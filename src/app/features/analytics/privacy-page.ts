import type { TuiNotificationService } from '@taiga-ui/core';
import type { Analytics, AnalyticsState } from '../../core/ipc/analytics';
import { notifyError } from '../project-tree/save-error';

export const UNSAVED_DENIAL =
  'Off for this session. The setting could not be saved; Carapace will try again.';

/** Refused, but only in memory: the next launch could ask again until the file is written. */
export function unsavedDenial(state: AnalyticsState | null): boolean {
  return state !== null && state.consent === 'denied' && !state.persisted;
}

/** The policy opens in the system browser through the backend; the webview never navigates. */
export function openPrivacyPage(analytics: Analytics, alerts: TuiNotificationService): void {
  analytics.openPrivacyPage().catch((err: unknown) => notifyError(alerts, err, 'Link not opened'));
}
