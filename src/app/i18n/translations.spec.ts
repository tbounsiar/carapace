import en from './en.json';
import fr from './fr.json';

function keys(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) {
    return [prefix];
  }
  return Object.entries(value).flatMap(([key, child]) =>
    keys(child, prefix ? `${prefix}.${key}` : key),
  );
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

  it('use the same placeholders in both languages', () => {
    const placeholders = (lang: object, key: string) => {
      const text = key
        .split('.')
        .reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], lang);
      return (
        String(text)
          .match(/{{\s*\w+\s*}}/g)
          ?.sort() ?? []
      );
    };
    for (const key of keys(en)) {
      expect(placeholders(fr, key), key).toEqual(placeholders(en, key));
    }
  });
});
