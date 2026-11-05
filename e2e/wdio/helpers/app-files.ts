import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The files of the app home (`$CARAPACE_HOME`): `data.json` (projects, nodes, variables, keys)
 * and `settings.toml` (app preferences). A lone `config.json` is the pre-split file, migrated on
 * first access.
 */
export const appHome = () => process.env['E2E_CARAPACE_HOME'] ?? '';
export const homeFile = (name: string) => join(appHome(), name);

export type Toml = { [key: string]: TomlValue };
export type TomlValue = string | number | boolean | Toml;

export const EMPTY_DATA = { version: 3, variables: [], projects: [], nodes: [], keys: [] };

export function writeData(data: object = EMPTY_DATA): void {
  writeFileSync(homeFile('data.json'), JSON.stringify(data, null, 2));
}

export function readData() {
  return JSON.parse(readFileSync(homeFile('data.json'), 'utf8'));
}

export function writeConfigJson(config: object): void {
  writeFileSync(homeFile('config.json'), JSON.stringify(config, null, 2));
}

export function writeSettings(settings: Toml): void {
  writeFileSync(homeFile('settings.toml'), stringifyToml(settings));
}

/** `settings.toml` parsed, or null when the file does not exist. */
export function readSettings(): Toml | null {
  const file = homeFile('settings.toml');
  return existsSync(file) ? parseToml(readFileSync(file, 'utf8')) : null;
}

/** Rewrites `settings.toml` (an absent file counts as empty); the app must be stopped. */
export function editSettings(change: (settings: Toml) => void): void {
  const settings = readSettings() ?? {};
  change(settings);
  writeSettings(settings);
}

export function removeHomeFiles(...names: string[]): void {
  for (const name of names) rmSync(homeFile(name), { force: true });
}

function stringifyToml(table: Toml): string {
  const lines: string[] = [];
  const write = (t: Toml, path: string[]) => {
    const tables: [string, Toml][] = [];
    const scalars: string[] = [];
    for (const [key, value] of Object.entries(t)) {
      if (typeof value === 'object') tables.push([key, value]);
      else scalars.push(`${key} = ${typeof value === 'string' ? JSON.stringify(value) : value}`);
    }
    if (path.length > 0 && scalars.length > 0) lines.push('', `[${path.join('.')}]`);
    lines.push(...scalars);
    for (const [key, sub] of tables) write(sub, [...path, key]);
  };
  write(table, []);
  return `${lines.join('\n').trim()}\n`;
}

/**
 * Reads what the backend writes: `[a.b]` headers, bare keys, basic and literal strings, integers
 * and booleans. Anything else throws, so an unexpected file fails the test instead of passing.
 */
export function parseToml(text: string): Toml {
  const root: Toml = {};
  let current = root;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const header = /^\[([A-Za-z0-9_.-]+)\]$/.exec(line);
    if (header) {
      current = root;
      for (const part of header[1].split('.')) {
        current[part] ??= {};
        current = current[part] as Toml;
      }
      continue;
    }
    const entry = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!entry) throw new Error(`unsupported TOML line: ${line}`);
    current[entry[1]] = tomlValue(entry[2]);
  }
  return root;
}

function tomlValue(raw: string): TomlValue {
  if (raw === 'true' || raw === 'false') return raw === 'true';
  if (/^[+-]?\d+$/.test(raw)) return Number(raw);
  if (/^'[^']*'$/.test(raw)) return raw.slice(1, -1);
  if (/^"(?:[^"\\]|\\.)*"$/.test(raw))
    return JSON.parse(
      raw.replace(/\\U([0-9A-Fa-f]{8})/g, (_m, hex: string) =>
        JSON.stringify(String.fromCodePoint(parseInt(hex, 16))).slice(1, -1),
      ),
    );
  throw new Error(`unsupported TOML value: ${raw}`);
}
