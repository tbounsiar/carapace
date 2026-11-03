export type EnvironmentKind = 'production' | 'staging' | 'development' | 'other';

export interface EnvironmentMarker {
  readonly kind: EnvironmentKind;
  readonly label: string;
  /** Production uses a solid badge: the pale `negative` one is hard to read on the dark chrome. */
  readonly appearance: 'primary-destructive' | 'warning' | 'positive' | 'neutral';
  readonly color: string;
}

const WORDS: readonly (readonly [EnvironmentKind, readonly string[]])[] = [
  ['staging', ['preprod', 'preproduction']],
  ['production', ['prod', 'production', 'live']],
  ['staging', ['staging', 'stage', 'uat', 'qa']],
  ['development', ['dev', 'development', 'local', 'test']],
];

const MARKERS: Record<EnvironmentKind, EnvironmentMarker> = {
  production: {
    kind: 'production',
    label: 'prod',
    appearance: 'primary-destructive',
    color: 'var(--tui-status-negative)',
  },
  staging: {
    kind: 'staging',
    label: 'staging',
    appearance: 'warning',
    color: 'var(--tui-status-warning)',
  },
  development: {
    kind: 'development',
    label: 'dev',
    appearance: 'positive',
    color: 'var(--tui-status-positive)',
  },
  other: { kind: 'other', label: '', appearance: 'neutral', color: 'var(--tui-status-neutral)' },
};

function words(name: string): Set<string> {
  const tokens = name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.replace(/\d+$/, ''))
    .filter(Boolean);
  const pairs = tokens.slice(1).map((token, i) => tokens[i] + token);
  return new Set([...tokens, ...pairs]);
}

/** UI-only guess from the environment name; the backend has no notion of environment kind. */
export function environmentKind(name: string): EnvironmentKind {
  const found = words(name);
  for (const [kind, candidates] of WORDS) {
    if (candidates.some((word) => found.has(word))) {
      return kind;
    }
  }
  return 'other';
}

export function environmentMarker(name: string): EnvironmentMarker {
  return MARKERS[environmentKind(name)];
}
