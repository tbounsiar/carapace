import { type MessageFormatElement, parse, TYPE } from '@formatjs/icu-messageformat-parser';
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
  const walk = (elements: MessageFormatElement[]) => {
    for (const element of elements) {
      if (
        element.type === TYPE.argument ||
        element.type === TYPE.number ||
        element.type === TYPE.date ||
        element.type === TYPE.time ||
        element.type === TYPE.plural ||
        element.type === TYPE.select
      ) {
        names.add(element.value);
      }
      if (element.type === TYPE.plural || element.type === TYPE.select) {
        Object.values(element.options).forEach((option) => walk(option.value));
      } else if (element.type === TYPE.tag) {
        walk(element.children);
      }
    }
  };
  walk(parse(message, { ignoreTag: true }));
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

  it('use the typographic apostrophe in French', () => {
    const straight = keys(fr).filter((key) => /\p{L}'\p{L}/u.test(String(text(fr, key))));
    expect(straight).toEqual([]);
  });
});
