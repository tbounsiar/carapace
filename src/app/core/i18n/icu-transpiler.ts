import { Service } from '@angular/core';
import type { TranslocoTranspiler, TranspileParams } from '@jsverse/transloco';
import { IntlMessageFormat } from 'intl-messageformat';
import { type MessageFormatElement, TYPE } from '@formatjs/icu-messageformat-parser';

/** Arguments that select a plural branch; the others are shown as given (no digit grouping). */
function pluralArguments(
  ast: readonly MessageFormatElement[],
  out = new Set<string>(),
): Set<string> {
  for (const element of ast) {
    if (element.type === TYPE.plural || element.type === TYPE.select) {
      if (element.type === TYPE.plural) {
        out.add(element.value);
      }
      for (const option of Object.values(element.options)) {
        pluralArguments(option.value, out);
      }
    } else if (element.type === TYPE.tag) {
      pluralArguments(element.children, out);
    }
  }
  return out;
}

interface Compiled {
  readonly format: IntlMessageFormat;
  readonly plurals: Set<string>;
}

/**
 * ICU messages (`{name}`, plural, select) interpreted at runtime. `@messageformat/core` compiles
 * messages with `new Function`, which the app's CSP (no `unsafe-eval`) refuses.
 */
@Service()
export class IcuTranspiler implements TranslocoTranspiler {
  private locale = 'en-US';
  private readonly cache = new Map<string, Compiled>();

  onLangChanged(lang: string): void {
    this.locale = lang === 'fr' ? 'fr-FR' : 'en-US';
    this.cache.clear();
  }

  transpile({ value, params }: TranspileParams): unknown {
    if (typeof value !== 'string' || !value.includes('{')) {
      return value;
    }
    try {
      const compiled = this.compile(value);
      const values: Record<string, unknown> = {};
      for (const [name, param] of Object.entries(params ?? {})) {
        values[name] =
          typeof param === 'number' && !compiled.plurals.has(name) ? String(param) : param;
      }
      return compiled.format.format(values as Record<string, string>);
    } catch {
      return value;
    }
  }

  private compile(message: string): Compiled {
    let compiled = this.cache.get(message);
    if (!compiled) {
      const format = new IntlMessageFormat(message, this.locale, undefined, { ignoreTag: true });
      compiled = { format, plurals: pluralArguments(format.getAst()) };
      this.cache.set(message, compiled);
    }
    return compiled;
  }
}
