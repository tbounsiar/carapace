import { type BackendText, isBackendText } from '../core/ipc/backend-text';
import { uiText } from './ui-text';

/** Lists shown one item per line; every other list param is joined with "; ". */
const LINE_LISTS: ReadonlySet<string> = new Set(['errors.dataTransfer.invalidFile']);

function param(value: unknown, separator: string): unknown {
  if (isBackendText(value)) {
    return textOf(value);
  }
  if (Array.isArray(value) && value.length && value.every(isBackendText)) {
    return value.map(textOf).join(separator);
  }
  return value;
}

/**
 * A backend text in the active language: nested texts in `params` are translated first. Falls
 * back to the English `message` when there is no key or the translation is missing or broken.
 * Reading it in a `computed` follows a language switch (see `uiText`).
 */
export function textOf(text: BackendText): string {
  const { key, params, message } = text;
  if (!key) {
    return message;
  }
  const separator = LINE_LISTS.has(key) ? '\n' : '; ';
  const values: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(params ?? {})) {
    values[name] = param(value, separator);
  }
  try {
    const translated = uiText(key, values);
    return translated && translated !== key ? translated : message;
  } catch {
    return message;
  }
}
