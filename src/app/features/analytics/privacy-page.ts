import type { TranslocoService } from '@jsverse/transloco';
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
  /** Translation keys. */
  readonly title: string;
  readonly note: string;
}

/** Same strings in the first-launch dialog and in Settings. */
export const CATEGORY_COPY: readonly CategoryCopy[] = ANALYTICS_CATEGORIES.map((id) => ({
  id,
  title: `analytics.categories.${id}.title`,
  note: `analytics.categories.${id}.note`,
}));

export const COMMON_LEAD = 'analytics.common.lead';
export const COMMON_TEXT = 'analytics.common.text';
export const NEVER_LEAD = 'analytics.never.lead';
export const NEVER_TEXT = 'analytics.never.text';

export const UNSAVED_DENIAL = 'analytics.unsavedDenial';

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
export function openPrivacyPage(
  analytics: Analytics,
  alerts: TuiNotificationService,
  transloco: TranslocoService,
): void {
  analytics
    .openPrivacyPage()
    .catch((err: unknown) =>
      notifyError(alerts, err, transloco.translate('analytics.linkNotOpened')),
    );
}
