import { TestBed } from '@angular/core/testing';
import { TranslocoService } from '@jsverse/transloco';
import type { AnalyticsChoices, AnalyticsState } from '../../core/ipc/analytics';
import { CATEGORY_COPY, initialChoices } from './privacy-page';

const OFF: AnalyticsChoices = {
  launch: false,
  features: false,
  connections: false,
  crashes: false,
};

const state = (
  categories: AnalyticsChoices,
  pending: AnalyticsState['pending'],
): AnalyticsState => ({
  categories,
  pending,
  doNotTrack: false,
  askNeeded: pending.length > 0,
  available: true,
  persisted: true,
});

describe('CATEGORY_COPY', () => {
  it('lists the four categories, crash reports last', () => {
    const transloco = TestBed.inject(TranslocoService);
    expect(CATEGORY_COPY.map((c) => [c.id, transloco.translate(c.title)])).toEqual([
      ['launch', 'Launch count'],
      ['features', 'Feature usage'],
      ['connections', 'Connection results'],
      ['crashes', 'Crash reports'],
    ]);
    expect(transloco.translate(CATEGORY_COPY[3].note)).toBe(
      'If Carapace crashes: crash type, app area and, in its own code, the source line. No messages or paths.',
    );
  });
});

describe('initialChoices', () => {
  it('turns every pending category on for a first launch', () => {
    expect(initialChoices(state(OFF, ['launch', 'features', 'connections', 'crashes']))).toEqual({
      launch: true,
      features: true,
      connections: true,
      crashes: true,
    });
  });

  it('keeps stored values and turns a pending crash reports category on', () => {
    expect(
      initialChoices(
        state({ launch: false, features: true, connections: false, crashes: false }, ['crashes']),
      ),
    ).toEqual({ launch: false, features: true, connections: false, crashes: true });
  });

  it('starts crash reports off when the three others are stored as denied', () => {
    expect(initialChoices(state(OFF, ['crashes']))).toEqual(OFF);
  });

  it('starts crash reports on when another category is pending rather than denied', () => {
    expect(initialChoices(state(OFF, ['connections', 'crashes']))).toEqual({
      launch: false,
      features: false,
      connections: true,
      crashes: true,
    });
  });

  it('shows a stored crash reports grant as on', () => {
    expect(initialChoices(state({ ...OFF, crashes: true }, ['launch']))).toEqual({
      ...OFF,
      launch: true,
      crashes: true,
    });
  });
});
