import type { HostInput, Project, VariableView } from '../core/ipc/config.models';
import { uiText } from './ui-text';

export const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
export const TEMPLATE_MAX = 1024;

export type Segment = { readonly text: string } | { readonly ref: string };

/** `${name}` is a reference, `$$` a literal `$`; any other `$` stays literal. */
export function parseTemplate(template: string): Segment[] {
  const segments: Segment[] = [];
  let text = '';
  let i = 0;
  while (i < template.length) {
    const char = template[i];
    if (char === '$' && template[i + 1] === '$') {
      text += '$';
      i += 2;
      continue;
    }
    if (char === '$' && template[i + 1] === '{') {
      const end = template.indexOf('}', i + 2);
      const name = end < 0 ? '' : template.slice(i + 2, end);
      if (VARIABLE_NAME.test(name)) {
        if (text) {
          segments.push({ text });
          text = '';
        }
        segments.push({ ref: name });
        i = end + 1;
        continue;
      }
    }
    text += char;
    i++;
  }
  if (text) {
    segments.push({ text });
  }
  return segments;
}

/** The backend rejects a `${` that does not start a valid reference; `$${` is a literal. */
export function invalidReference(template: string): string | null {
  for (let i = 0; i < template.length; i++) {
    if (template[i] !== '$') {
      continue;
    }
    if (template[i + 1] === '$') {
      i++;
    } else if (template[i + 1] === '{') {
      const end = template.indexOf('}', i + 2);
      const name = end < 0 ? '' : template.slice(i + 2, end);
      if (!VARIABLE_NAME.test(name)) {
        return template.slice(i, end < 0 ? undefined : end + 1);
      }
      i = end;
    }
  }
  return null;
}

export function hasReferences(template: string): boolean {
  return parseTemplate(template).some((s) => 'ref' in s);
}

/** Secret fields (and a templated port) hold exactly one reference and nothing else. */
export function secretReferenceName(template: string): string | null {
  const segments = parseTemplate(template);
  return segments.length === 1 && 'ref' in segments[0] ? segments[0].ref : null;
}

export interface VariableLayers {
  readonly global: readonly VariableView[];
  readonly project: readonly VariableView[];
}

/** A Home host (`project` null) sees the global variables only. */
export function variableLayers(
  global: readonly VariableView[],
  project: Pick<Project, 'variables'> | null,
): VariableLayers {
  return { global, project: project?.variables ?? [] };
}

/** The project wins over the global level. */
export function lookupVariable(layers: VariableLayers, name: string): VariableView | null {
  for (const layer of [layers.project, layers.global]) {
    const found = layer.find((v) => v.name === name);
    if (found) {
      return found;
    }
  }
  return null;
}

export interface Resolution {
  readonly value: string;
  readonly missing: readonly string[];
  readonly errors: readonly string[];
}

export function resolveTemplate(template: string, layers: VariableLayers): Resolution {
  let value = '';
  const missing: string[] = [];
  const errors: string[] = [];
  for (const segment of parseTemplate(template)) {
    if ('text' in segment) {
      value += segment.text;
      continue;
    }
    const variable = lookupVariable(layers, segment.ref);
    if (!variable) {
      missing.push(segment.ref);
    } else if (variable.kind === 'secret') {
      errors.push(uiText('common.template.secretInPlain', { name: segment.ref }));
    } else {
      value += variable.value ?? '';
    }
  }
  return { value, missing, errors };
}

export interface HostPreview {
  readonly address: string;
  readonly missing: readonly string[];
  readonly errors: readonly string[];
}

/** UI-only mirror of the backend resolution, so an unsaved host can be previewed while typing. */
export function previewHost(host: HostInput, layers: VariableLayers): HostPreview {
  const missing = new Set<string>();
  const errors: string[] = [];
  const plain = (template: string): string => {
    const invalid = invalidReference(template);
    if (invalid) {
      errors.push(uiText('common.template.invalidReference', { ref: invalid }));
    }
    const result = resolveTemplate(template, layers);
    result.missing.forEach((name) => missing.add(name));
    errors.push(...result.errors);
    return result.value;
  };
  const secret = (field: 'password' | 'passphrase', template: string | null): void => {
    if (template === null) {
      return;
    }
    const name = secretReferenceName(template);
    if (!name) {
      errors.push(uiText(`common.template.${field}Single`, { ref: '${name}' }));
      return;
    }
    const variable = lookupVariable(layers, name);
    if (!variable) {
      missing.add(name);
    } else if (variable.kind !== 'secret') {
      errors.push(uiText('common.template.plainInSecret', { name }));
    }
  };

  const hostname = plain(host.hostname);
  if (hasReferences(host.port) && !secretReferenceName(host.port)) {
    errors.push(uiText('common.template.portReference', { ref: '${name}' }));
  }
  const port = plain(host.port);
  const username = plain(host.username);
  if (host.auth.kind === 'key') {
    plain(host.auth.keyPath);
    secret('passphrase', host.auth.passphrase);
  } else if (host.auth.kind === 'password') {
    secret('password', host.auth.password);
  }
  if (missing.size === 0 && !errors.length) {
    const n = Number(port);
    if (!/^\d+$/.test(port) || n < 1 || n > 65535) {
      errors.push(uiText('common.template.portRange', { port }));
    }
  }
  return { address: `${username}@${hostname}:${port}`, missing: [...missing], errors };
}

/** Secret variable names defined at any level a host of the project can see. */
export function secretVariableNames(
  global: readonly VariableView[],
  project: Pick<Project, 'variables'> | null,
): string[] {
  const names = new Set<string>();
  for (const layer of [global, project?.variables ?? []]) {
    for (const variable of layer) {
      if (variable.kind === 'secret') {
        names.add(variable.name);
      }
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

/** Every `${name}` the host's fields use, plain and secret. */
export function hostReferences(host: HostInput): string[] {
  const fields = [host.hostname, host.port, host.username];
  if (host.auth.kind === 'key') {
    fields.push(host.auth.keyPath, host.auth.passphrase ?? '');
  } else if (host.auth.kind === 'password') {
    fields.push(host.auth.password ?? '');
  }
  const names = new Set<string>();
  for (const field of fields) {
    for (const segment of parseTemplate(field)) {
      if ('ref' in segment) {
        names.add(segment.ref);
      }
    }
  }
  return [...names];
}

/** References neither the global nor the target project variables define, sorted; `project` null is Home. */
export function undefinedReferences(
  hosts: readonly HostInput[],
  global: readonly VariableView[],
  project: Pick<Project, 'variables'> | null,
): string[] {
  const defined = new Set(
    [global, project?.variables ?? []].flatMap((layer) => layer.map((v) => v.name)),
  );
  const missing = new Set<string>();
  for (const host of hosts) {
    for (const name of hostReferences(host)) {
      if (!defined.has(name)) {
        missing.add(name);
      }
    }
  }
  return [...missing].sort((a, b) => a.localeCompare(b));
}
