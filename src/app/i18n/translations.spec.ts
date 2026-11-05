import { parse, type Token } from '@messageformat/parser';
import en from './en';
import fr from './fr';

function keys(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) {
    return [prefix];
  }
  return Object.entries(value).flatMap(([key, child]) =>
    keys(child, prefix ? `${prefix}.${key}` : key),
  );
}

function text(lang: object, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], lang);
}

function argumentNames(message: string): Set<string> {
  const names = new Set<string>();
  const walk = (tokens: Token[]) => {
    for (const token of tokens) {
      if (token.type === 'argument' || token.type === 'function') {
        names.add(token.arg);
      } else if (
        token.type === 'plural' ||
        token.type === 'select' ||
        token.type === 'selectordinal'
      ) {
        names.add(token.arg);
        token.cases.forEach((c) => walk(c.tokens));
      }
    }
  };
  walk(parse(message));
  return names;
}

describe('translations', () => {
  it('have the same keys in English and French', () => {
    expect(keys(fr).sort()).toEqual(keys(en).sort());
  });

  it('have no empty text', () => {
    for (const lang of [en, fr]) {
      const empty = keys(lang).filter((key) => {
        const text = key
          .split('.')
          .reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], lang);
        return typeof text !== 'string' || text.trim() === '';
      });
      expect(empty).toEqual([]);
    }
  });

  // French may also select on grammatical agreement, which English ignores.
  it('use the same arguments in both languages', () => {
    const grammar = ['gender', 'form', 'kind'];
    const args = (lang: object, key: string) => [...argumentNames(String(text(lang, key)))].sort();
    for (const key of keys(en)) {
      const english = args(en, key);
      const french = args(fr, key).filter((a) => !grammar.includes(a) || english.includes(a));
      expect(french, key).toEqual(english);
    }
  });

  // `{{x}}` is substituted before the ICU parse, so a value holding `{`, `}` or `#` breaks it.
  it('use ICU arguments, never {{x}} interpolation', () => {
    for (const lang of [en, fr]) {
      const doubled = keys(lang).filter((key) => /\{\{\s*\w+\s*\}\}/.test(String(text(lang, key))));
      expect(doubled).toEqual([]);
    }
  });
});
