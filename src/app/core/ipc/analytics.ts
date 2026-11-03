import { Service, signal } from '@angular/core';
import type { ThemeMode } from '../theme/theme';
import { invokeCommand } from './ipc-error';

export type AnalyticsConsent = 'unset' | 'granted' | 'denied';

export interface AnalyticsState {
  readonly consent: AnalyticsConsent;
  /** The consent dialog should be shown this launch. */
  readonly askNeeded: boolean;
  /** False in builds without an Aptabase key: nothing leaves the machine. */
  readonly available: boolean;
  /** False when the consent applies in memory but could not be written to the config file. */
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
  readonly props: Readonly<Record<string, AnalyticsPropValue>>;
}

export interface AnalyticsRecent {
  readonly system: AnalyticsSystem;
  /** Newest first, at most 50. */
  readonly events: readonly AnalyticsEvent[];
}

/**
 * Consent and the local event log. Events are built in Rust only; there is deliberately no
 * command to report an event from here.
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

  /**
   * On failure the state is read again before rethrowing, so `current` shows what the backend
   * applies (it gates on the in-memory value before writing the file), not the value before.
   */
  async setConsent(granted: boolean): Promise<AnalyticsState> {
    try {
      const state = await invokeCommand<AnalyticsState>('set_analytics_consent', { granted });
      this._current.set(state);
      return state;
    } catch (err) {
      await this.state().catch(() => undefined);
      throw err;
    }
  }

  recent(): Promise<AnalyticsRecent> {
    return invokeCommand<AnalyticsRecent>('analytics_recent');
  }

  /** The backend ignores it without consent and sends it once per session. */
  appStarted(theme: ThemeMode): Promise<void> {
    return invokeCommand<void>('analytics_app_started', { theme });
  }

  /** Opens the privacy policy in the system browser, never in the webview. */
  openPrivacyPage(): Promise<void> {
    return invokeCommand<void>('open_privacy_page');
  }
}
