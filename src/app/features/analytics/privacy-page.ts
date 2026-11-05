import type { TuiNotificationService } from '@taiga-ui/core';
import {
  ANALYTICS_CATEGORIES,
  type Analytics,
  type AnalyticsCategory,
  type AnalyticsChoices,
  type AnalyticsState,
} from '../../core/ipc/analytics';
import { notifyError } from '../../shared/save-error';

export interface CategoryCopy {
  readonly id: AnalyticsCategory;
  readonly title: string;
  readonly note: string;
}

/** Same strings in the first-launch dialog and in Settings. */
export const CATEGORY_COPY: readonly CategoryCopy[] = [
  { id: 'launch', title: 'Launch count', note: 'One event when Carapace starts.' },
  {
    id: 'features',
    title: 'Feature usage',
    note: 'Terminals, files, transfers, keys and variables used; setup sizes as ranges.',
  },
  {
    id: 'connections',
    title: 'Connection results',
    note: 'Whether connections and tests succeed: auth type, error code, time as a range.',
  },
  {
    id: 'crashes',
    title: 'Crash reports',
    note: 'If Carapace crashes: crash type, app area and, in its own code, the source line. No messages or paths.',
  },
];

export const COMMON_LEAD = 'Sent with every event:';
export const COMMON_TEXT =
  'app version, OS and version, language, and a random ID that changes at each launch. Country and region are derived from the connection; the IP is not kept.';
export const NEVER_LEAD = 'Never sent:';
export const NEVER_TEXT =
  'host names, addresses, usernames, file names, keys, passwords or anything you type.';

export const UNSAVED_DENIAL =
  'Off for this session. The setting could not be saved; Carapace will try again.';

/** A refusal applies in memory only: the next launch could ask again until the file is written. */
export function unsavedDenial(state: AnalyticsState | null): boolean {
  return state !== null && !state.persisted;
}

const USAGE_CATEGORIES: readonly AnalyticsCategory[] = ['launch', 'features', 'connections'];

/**
 * What the dialog shows first: every pending category on, the others as stored. A pending crash
 * reports category starts off for someone who refused all three usage categories: switching on a
 * new kind of data that Escape would grant contradicts a recorded refusal.
 */
export function initialChoices(state: AnalyticsState): AnalyticsChoices {
  const denied = (category: AnalyticsCategory) =>
    !state.categories[category] && !state.pending.includes(category);
  const refusedAll = USAGE_CATEGORIES.every(denied);
  const choices = {} as AnalyticsChoices;
  for (const category of ANALYTICS_CATEGORIES) {
    const pending = state.pending.includes(category);
    choices[category] =
      (pending && !(category === 'crashes' && refusedAll)) || state.categories[category];
  }
  return choices;
}

/** The policy opens in the system browser through the backend; the webview never navigates. */
export function openPrivacyPage(analytics: Analytics, alerts: TuiNotificationService): void {
  analytics.openPrivacyPage().catch((err: unknown) => notifyError(alerts, err, 'Link not opened'));
}
