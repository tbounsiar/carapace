import { environmentKind, environmentMarker } from './environment-kind';

describe('environmentKind', () => {
  it.each([
    ['prod', 'production'],
    ['Production', 'production'],
    ['live', 'production'],
    ['prod-eu', 'production'],
    ['EU Prod 2', 'production'],
    ['prod1', 'production'],
    ['staging', 'staging'],
    ['stage', 'staging'],
    ['preprod', 'staging'],
    ['pre-prod', 'staging'],
    ['Pre Production', 'staging'],
    ['UAT', 'staging'],
    ['qa', 'staging'],
    ['dev', 'development'],
    ['development', 'development'],
    ['local', 'development'],
    ['test', 'development'],
    ['sandbox', 'other'],
    ['', 'other'],
    ['product', 'other'],
    ['devops', 'other'],
  ])('classifies "%s" as %s', (name, kind) => {
    expect(environmentKind(name)).toBe(kind);
  });

  it('treats an ambiguous name as production first', () => {
    expect(environmentKind('prod-test')).toBe('production');
  });
});

describe('environmentMarker', () => {
  it('maps kinds to Taiga status appearances', () => {
    expect(environmentMarker('prod')).toMatchObject({
      appearance: 'negative',
      color: 'var(--tui-status-negative)',
    });
    expect(environmentMarker('qa').appearance).toBe('warning');
    expect(environmentMarker('dev').appearance).toBe('positive');
    expect(environmentMarker('misc')).toMatchObject({ appearance: 'neutral', label: '' });
  });
});
