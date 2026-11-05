import { Service, signal } from '@angular/core';
import type { ThemeMode } from '../theme/theme';
import { invokeCommand } from './ipc-error';

export type AnalyticsCategory = 'launch' | 'features' | 'connections' | 'crashes';

/** Display order everywhere; crash reports last, as the only one not about normal use. */
export const ANALYTICS_CATEGORIES: readonly AnalyticsCategory[] = [
  'launch',
  'features',
  'connections',
  'crashes',
];

export type AnalyticsChoices = Record<AnalyticsCategory, boolean>;

export interface AnalyticsState {
  /** Granted and current, as stored; ignores `doNotTrack`. */
  readonly categories: Readonly<AnalyticsChoices>;
  /** Unset or granted for an older catalogue: the dialog asks these. */
  readonly pending: readonly AnalyticsCategory[];
  /** DO_NOT_TRACK is set: every category is off this launch, whatever is stored. */
  readonly doNotTrack: boolean;
  /** The consent dialog should be shown this launch. */
  readonly askNeeded: boolean;
  /** False in builds without an Aptabase key: nothing leaves the machine. */
  readonly available: boolean;
  /** False while a refusal applies in memory but could not be written to the config file. */
  readonly persisted: boolean;
}

export interface AnalyticsSystem {
  readonly appVersion: string;
  readonly os: string;
  readonly osVersion: string;
  readonly locale: string;
  readonly sdkVersion: string;
  /** Random, memory only, rotates; not an install id. */
  readonly sessionId: string;
}

export type AnalyticsPropValue = string | number | boolean;

export interface AnalyticsEvent {
  /** ISO 8601, UTC. */
  readonly time: string;
  readonly name: string;
  /** Empty object for events without properties. */
  readonly props: Readonly<Record<string, AnalyticsPropValue>>;
  /** Only on a crash report saved by the previous launch and sent at this one. */
  readonly previousLaunch?: true;
}

export interface AnalyticsRecent {
  readonly system: AnalyticsSystem;
  /** Newest first, at most 50. */
  readonly events: readonly AnalyticsEvent[];
}

/**
 * Per-category choices and the local event log. Events are built in Rust only; there is
 * deliberately no command to report an event from here.
 */
@Service()
export class Analytics {
  private readonly _current = signal<AnalyticsState | null>(null);
  /** Last state read or saved; null until the first successful call. */
  readonly current = this._current.asReadonly();

  async state(): Promise<AnalyticsState> {
    const state = await invokeCommand<AnalyticsState>('analytics_state');
    this._current.set(state);
    return state;
  }

  /** The first-launch dialog: every category in one write. */
  setChoices(choices: AnalyticsChoices): Promise<AnalyticsState> {
    return this.save('set_analytics_choices', { choices });
  }

  /** Settings: touches this category only, so a pending one is not stamped as answered. */
  setCategory(category: AnalyticsCategory, granted: boolean): Promise<AnalyticsState> {
    return this.save('set_analytics_category', { category, granted });
  }

  recent(): Promise<AnalyticsRecent> {
    return invokeCommand<AnalyticsRecent>('analytics_recent');
  }

  /** The backend ignores it unless feature usage is on, and sends it once per session. */
  appStarted(theme: ThemeMode): Promise<void> {
    return invokeCommand<void>('analytics_app_started', { theme });
  }

  /** Opens the privacy policy in the system browser, never in the webview. */
  openPrivacyPage(): Promise<void> {
    return invokeCommand<void>('open_privacy_page');
  }

  /**
   * On failure the state is read again before rethrowing, so `current` shows what the backend
   * applies (a refusal takes effect in memory before the file is written), not the value before.
   */
  private async save(command: string, args: Record<string, unknown>): Promise<AnalyticsState> {
    try {
      const state = await invokeCommand<AnalyticsState>(command, args);
      this._current.set(state);
      return state;
    } catch (err) {
      await this.state().catch(() => undefined);
      throw err;
    }
  }
}
