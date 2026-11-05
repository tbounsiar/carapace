import { translate } from '@jsverse/transloco';

export type LanguageId = 'plain' | 'shell' | 'yaml' | 'json' | 'ini' | 'nginx' | 'dockerfile';

/** `key` is the translation of a label that is not a name. */
export const LANGUAGES: readonly {
  readonly id: LanguageId;
  readonly label: string;
  readonly key?: string;
}[] = [
  { id: 'plain', label: 'Plain text', key: 'editor.languages.plain' },
  { id: 'shell', label: 'Shell' },
  { id: 'yaml', label: 'YAML' },
  { id: 'json', label: 'JSON' },
  { id: 'ini', label: 'INI / properties', key: 'editor.languages.ini' },
  { id: 'nginx', label: 'nginx' },
  { id: 'dockerfile', label: 'Dockerfile' },
];

/** Larger files open as plain text; highlighting them would cost more than it helps. */
export const HIGHLIGHT_LIMIT = 1024 * 1024;

const SHELL_NAMES = new Set([
  '.bashrc',
  '.bash_profile',
  '.bash_aliases',
  '.profile',
  '.zshrc',
  '.zprofile',
]);
const INI_EXTENSIONS = new Set([
  'ini',
  'conf',
  'cfg',
  'cnf',
  'properties',
  'env',
  'service',
  'timer',
  'socket',
  'mount',
]);

export function languageLabel(id: LanguageId): string {
  const language = LANGUAGES.find((l) => l.id === id) ?? LANGUAGES[0];
  return language.key ? translate(language.key) : language.label;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1) : '';
}

/** First rule that matches the remote path, case-insensitive (spec E6). */
export function detectLanguage(path: string): LanguageId {
  const segments = path.toLowerCase().split('/').filter(Boolean);
  const name = segments.at(-1) ?? '';
  const ext = extensionOf(name);
  if (
    name === 'dockerfile' ||
    name === 'containerfile' ||
    name.startsWith('dockerfile.') ||
    ext === 'dockerfile'
  ) {
    return 'dockerfile';
  }
  if (ext === 'json') {
    return 'json';
  }
  if (ext === 'yml' || ext === 'yaml') {
    return 'yaml';
  }
  if (ext === 'sh' || ext === 'bash' || ext === 'zsh' || SHELL_NAMES.has(name)) {
    return 'shell';
  }
  const inNginxDir = segments.slice(0, -1).includes('nginx');
  if (name === 'nginx.conf' || (inNginxDir && (ext === 'conf' || ext === ''))) {
    return 'nginx';
  }
  if (INI_EXTENSIONS.has(ext) || name === '.env' || name.startsWith('.env.')) {
    return 'ini';
  }
  return 'plain';
}

/** The language a tab opens with: plain text over the highlighting limit. */
export function initialLanguage(path: string, size: number): LanguageId {
  return size > HIGHLIGHT_LIMIT ? 'plain' : detectLanguage(path);
}
