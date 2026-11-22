import { IcuTranspiler } from './icu-transpiler';

describe('IcuTranspiler', () => {
  const run = (t: IcuTranspiler, value: string, params?: Record<string, unknown>) =>
    t.transpile({ value, params, translation: {}, key: 'k' });

  it('interpolates arguments as given, braces and hashes included', () => {
    const t = new IcuTranspiler();
    expect(run(t, 'Delete {name}?', { name: '${host}#{x}' })).toBe('Delete ${host}#{x}?');
    expect(run(t, 'between {min} and {max}', { min: 1, max: 65535 })).toBe('between 1 and 65535');
  });

  it('picks plural branches per language', () => {
    const t = new IcuTranspiler();
    const message = '{count, plural, one {# hôte} other {# hôtes}}';
    t.onLangChanged('fr');
    expect(run(t, message, { count: 0 })).toBe('0 hôte');
    expect(run(t, message, { count: 1500 })).toBe('1 500 hôtes');
    t.onLangChanged('en');
    expect(run(t, '{count, plural, one {# host} other {# hosts}}', { count: 0 })).toBe('0 hosts');
  });

  it('formats with the locale of each new language', () => {
    const t = new IcuTranspiler();
    t.onLangChanged('de');
    expect(run(t, '{count, plural, one {# Host} other {# Hosts}}', { count: 0 })).toBe('0 Hosts');
    expect(run(t, '{count, plural, one {# Host} other {# Hosts}}', { count: 1500 })).toBe(
      '1.500 Hosts',
    );
    t.onLangChanged('pt-BR');
    expect(run(t, '{count, plural, one {# host} other {# hosts}}', { count: 0 })).toBe('0 host');
    t.onLangChanged('es');
    expect(run(t, '{count, plural, one {# host} other {# hosts}}', { count: 0 })).toBe('0 hosts');
    t.onLangChanged('zh-CN');
    expect(run(t, '{count, plural, other {# 个主机}}', { count: 1500 })).toBe('1,500 个主机');
  });

  it('selects and leaves angle brackets alone', () => {
    const t = new IcuTranspiler();
    expect(run(t, '{what, select, host {Host} other {Item}} <b>', { what: 'host' })).toBe(
      'Host <b>',
    );
  });

  it('returns the text unchanged when it has no argument or cannot be formatted', () => {
    const t = new IcuTranspiler();
    expect(run(t, 'Plain text')).toBe('Plain text');
    expect(run(t, 'Hello {name}')).toBe('Hello {name}');
    expect(run(t, 'Broken {')).toBe('Broken {');
  });
});
