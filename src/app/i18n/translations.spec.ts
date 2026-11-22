import { type MessageFormatElement, parse, TYPE } from '@formatjs/icu-messageformat-parser';
import de from './de';
import en from './en';
import es from './es';
import fr from './fr';
import ptBR from './pt-BR';
import zhCN from './zh-CN';

const OTHERS: readonly (readonly [string, object])[] = [
  ['de', de],
  ['es', es],
  ['fr', fr],
  ['pt-BR', ptBR],
  ['zh-CN', zhCN],
];
const ALL: readonly (readonly [string, object])[] = [['en', en], ...OTHERS];

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
  it.each(OTHERS)('have the same keys in %s as in English', (_, lang) => {
    expect(keys(lang).sort()).toEqual(keys(en).sort());
  });

  it.each(ALL)('have no empty text in %s', (_, lang) => {
    const empty = keys(lang).filter((key) => {
      const value = text(lang, key);
      return typeof value !== 'string' || value.trim() === '';
    });
    expect(empty).toEqual([]);
  });

  it.each(ALL)('parse as ICU messages in %s', (_, lang) => {
    const broken = keys(lang).filter((key) => {
      try {
        parse(String(text(lang, key)), { ignoreTag: true });
        return false;
      } catch {
        return true;
      }
    });
    expect(broken).toEqual([]);
  });

  // Other languages may also select on grammatical agreement (or on a raw backend code English
  // only interpolates), which English ignores.
  it.each(OTHERS)('use the same arguments in %s as in English', (_, lang) => {
    const grammar = ['gender', 'form', 'kind', 'what', 'field', 'strategy'];
    const args = (source: object, key: string) =>
      [...argumentNames(String(text(source, key)))].sort();
    for (const key of keys(en)) {
      const english = args(en, key);
      const other = args(lang, key).filter((a) => !grammar.includes(a) || english.includes(a));
      expect(other, key).toEqual(english);
    }
  });

  // `{{x}}` is substituted before the ICU parse, so a value holding `{`, `}` or `#` breaks it.
  it.each(ALL)('use ICU arguments, never {{x}} interpolation, in %s', (_, lang) => {
    // `other {{kind}}` is an ICU branch holding an argument, not `{{x}}` interpolation.
    const doubled = keys(lang).filter((key) =>
      /(?<!\w\s?)\{\{\s*\w+\s*\}\}/.test(String(text(lang, key))),
    );
    expect(doubled).toEqual([]);
  });

  it('use the typographic apostrophe in French', () => {
    const straight = keys(fr).filter((key) => /\p{L}'\p{L}/u.test(String(text(fr, key))));
    expect(straight).toEqual([]);
  });

  it('list every language in the language error', () => {
    for (const [code, lang] of ALL) {
      expect(String(text(lang, 'errors.settings.language')), code).toMatch(
        /system.*en.*fr.*de.*es.*pt-BR.*zh-CN/,
      );
    }
  });
});
