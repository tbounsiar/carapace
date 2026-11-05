/**
 * A user-facing text sent by the backend: `key` (`errors.<area>.<name>`) and `params` are
 * translated by the interface, `message` is the English text shown when the key is unknown.
 * A param value may itself be a `BackendText` or a list of them.
 */
export interface BackendText {
  readonly key?: string;
  readonly params?: Readonly<Record<string, unknown>>;
  readonly message: string;
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isBackendText(value: unknown): value is BackendText {
  if (!isRecord(value) || typeof value['message'] !== 'string') {
    return false;
  }
  const { key, params } = value;
  return (
    (key === undefined || typeof key === 'string') && (params === undefined || isRecord(params))
  );
}

/** The `key`/`params` of a raw payload, dropping malformed values. */
export function textParts(raw: Readonly<Record<string, unknown>>): {
  key?: string;
  params?: Readonly<Record<string, unknown>>;
} {
  const { key, params } = raw;
  return {
    ...(typeof key === 'string' ? { key } : {}),
    ...(isRecord(params) ? { params } : {}),
  };
}
