import { Component, computed, inject, resource } from '@angular/core';
import { TuiTable } from '@taiga-ui/addon-table';
import { TuiAutoFocus } from '@taiga-ui/cdk';
import {
  TuiButton,
  type TuiDialogContext,
  TuiLoader,
  TuiNotification,
  TuiScrollbar,
  TuiTitle,
} from '@taiga-ui/core';
import { TuiBlockStatus, TuiList } from '@taiga-ui/layout';
import { injectContext } from '@taiga-ui/polymorpheus';
import { Analytics, type AnalyticsState } from '../../../core/ipc/analytics';

export interface EventRow {
  readonly time: string;
  readonly name: string;
  readonly props: readonly string[];
}

/**
 * Local clock time. `DatePipe` is avoided on purpose: it pulls `formatDate` into the initial bundle
 * through the shared common chunk.
 */
export function localTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

@Component({
  imports: [
    TuiAutoFocus,
    TuiBlockStatus,
    TuiButton,
    TuiList,
    TuiLoader,
    TuiNotification,
    TuiScrollbar,
    TuiTable,
    TuiTitle,
  ],
  selector: 'app-analytics-events-dialog',
  styleUrl: './analytics-events-dialog.scss',
  templateUrl: './analytics-events-dialog.html',
})
export class AnalyticsEventsDialog {
  private readonly analytics = inject(Analytics);
  protected readonly context = injectContext<TuiDialogContext<void, AnalyticsState>>();
  protected readonly state = this.context.data;

  /** A snapshot taken when the dialog opens; reopen it to refresh. */
  protected readonly recent = resource({ loader: () => this.analytics.recent() });

  protected readonly rows = computed<readonly EventRow[]>(() => {
    const value = this.recent.hasValue() ? this.recent.value() : null;
    return (value?.events ?? []).map((event) => ({
      time: localTime(event.time),
      name: event.name,
      props: Object.entries(event.props).map(([key, v]) => `${key}=${String(v)}`),
    }));
  });
}
