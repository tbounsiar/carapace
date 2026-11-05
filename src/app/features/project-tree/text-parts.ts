import { uiText } from '../../shared/ui-text';

/** A run of text; `mono` runs are technical values shown in the monospace font. */
export interface TextPart {
  readonly text: string;
  readonly mono: boolean;
}

const MARK = '\u0001';

/**
 * The translation of `key` split around the `mono` params, which come back as their own runs:
 * the sentence stays one translation while its code samples keep their own element.
 */
export function monoParts(
  key: string,
  mono: Readonly<Record<string, string>>,
  params?: Readonly<Record<string, unknown>>,
): TextPart[] {
  const names = Object.keys(mono);
  const marks = Object.fromEntries(names.map((name, i) => [name, `${MARK}${i}${MARK}`]));
  return uiText(key, { ...params, ...marks })
    .split(MARK)
    .map((chunk, i) =>
      i % 2 ? { text: mono[names[Number(chunk)]] ?? '', mono: true } : { text: chunk, mono: false },
    )
    .filter((part) => part.text !== '');
}
