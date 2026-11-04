import { pathHtml, pathParts } from './path-breaks';

describe('path breaks', () => {
  it('splits after each separator and keeps the text', () => {
    expect(pathParts('C:\\Users\\me\\.ssh\\id_ed25519')).toEqual([
      'C:\\',
      'Users\\',
      'me\\',
      '.ssh\\',
      'id_ed25519',
    ]);
    expect(pathParts('/srv//keys/')).toEqual(['/', 'srv//', 'keys/']);
    expect(pathParts('id')).toEqual(['id']);
    expect(pathParts('')).toEqual(['']);
  });

  it('escapes the parts for innerHTML', () => {
    expect(pathHtml('~/a<b>/c&d')).toBe('~/<wbr>a&lt;b&gt;/<wbr>c&amp;d');
  });
});
