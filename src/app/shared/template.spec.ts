import type { HostInput, VariableView } from '../core/ipc/config.models';
import {
  hasReferences,
  invalidReference,
  lookupVariable,
  parseTemplate,
  previewHost,
  resolveTemplate,
  secretReferenceName,
  secretVariableNames,
  undefinedReferences,
  variableLayers,
  type VariableLayers,
} from './template';

const plain = (name: string, value: string): VariableView => ({
  name,
  kind: 'plain',
  value,
  hasValue: true,
});
const secret = (name: string, hasValue = true): VariableView => ({
  name,
  kind: 'secret',
  value: null,
  hasValue,
});

const layers: VariableLayers = {
  global: [plain('user', 'carapace'), plain('port', '22')],
  project: [plain('host', 'example.com'), secret('pw')],
  environment: [plain('host', '127.0.0.1'), plain('port', '2223')],
};

describe('template', () => {
  it('parses references, $$ escapes and literal dollars', () => {
    expect(parseTemplate('${user}@${host}')).toEqual([
      { ref: 'user' },
      { text: '@' },
      { ref: 'host' },
    ]);
    expect(parseTemplate('a$$b$c${bad name}${x')).toEqual([{ text: 'a$b$c${bad name}${x' }]);
    expect(hasReferences('$${host}')).toBe(false);
    expect(hasReferences('x${a.b-c}')).toBe(true);
  });

  it('finds a ${ that does not start a valid reference', () => {
    expect(invalidReference('${user}@$${x}:$5')).toBeNull();
    expect(invalidReference('a${bad name}b')).toBe('${bad name}');
    expect(invalidReference('${open')).toBe('${open');
    expect(invalidReference('${}')).toBe('${}');
  });

  it('recognises a single secret reference only', () => {
    expect(secretReferenceName('${pw}')).toBe('pw');
    expect(secretReferenceName(' ${pw}')).toBeNull();
    expect(secretReferenceName('${a}${b}')).toBeNull();
    expect(secretReferenceName('plain')).toBeNull();
  });

  it('lets the environment win over the project and global levels', () => {
    expect(lookupVariable(layers, 'host')?.value).toBe('127.0.0.1');
    expect(lookupVariable(layers, 'user')?.value).toBe('carapace');
    expect(lookupVariable({ ...layers, environment: null }, 'host')?.value).toBe('example.com');
    expect(lookupVariable(layers, 'Host')).toBeNull();
  });

  it('resolves plain fields and reports missing and secret misuse', () => {
    expect(resolveTemplate('${user}@${host}:${port}', layers)).toEqual({
      value: 'carapace@127.0.0.1:2223',
      missing: [],
      errors: [],
    });
    const bad = resolveTemplate('${nope}-${pw}', layers);
    expect(bad.missing).toEqual(['nope']);
    expect(bad.errors[0]).toContain('secret variable pw');
  });

  describe('previewHost', () => {
    const host: HostInput = {
      name: 'ui',
      hostname: '${host}',
      port: '${port}',
      username: '${user}',
      auth: { kind: 'password', password: '${pw}' },
    };

    it('resolves the address', () => {
      expect(previewHost(host, layers)).toEqual({
        address: 'carapace@127.0.0.1:2223',
        missing: [],
        errors: [],
      });
    });

    it('lists each missing variable once, including secret references', () => {
      const preview = previewHost(
        { ...host, hostname: '${a}.${a}', auth: { kind: 'password', password: '${gone}' } },
        layers,
      );
      expect(preview.missing).toEqual(['a', 'gone']);
    });

    it('rejects a plain variable in a secret field and a bad port', () => {
      expect(
        previewHost({ ...host, auth: { kind: 'password', password: '${user}' } }, layers).errors[0],
      ).toContain('plain variable user');
      expect(previewHost({ ...host, port: '70000' }, layers).errors[0]).toContain('port');
      expect(previewHost({ ...host, port: '2${port}' }, layers).errors[0]).toContain(
        'single ${name}',
      );
    });

    it('reports an invalid reference', () => {
      expect(previewHost({ ...host, hostname: '${bad name}' }, layers).errors[0]).toContain(
        'invalid variable reference',
      );
    });
  });

  it('collects secret variable names from every level', () => {
    expect(
      secretVariableNames([secret('b')], {
        variables: [secret('a'), plain('c', '')],
        environments: [{ id: 'e1', name: 'dev', variables: [secret('b'), secret('d')] }],
      }),
    ).toEqual(['a', 'b', 'd']);
  });
});

describe('Home scope', () => {
  const host: HostInput = {
    name: 'vps',
    hostname: '${host}',
    port: '${port}',
    username: 'me',
    auth: { kind: 'password', password: '${pw}' },
  };

  it('layers global variables only', () => {
    expect(variableLayers([plain('a', '1')], null, null)).toEqual({
      global: [plain('a', '1')],
      project: [],
      environment: null,
    });
    expect(secretVariableNames([secret('g')], null)).toEqual(['g']);
  });

  it('lists references no level of the target defines, sorted', () => {
    expect(undefinedReferences([host], [plain('host', 'h')], null)).toEqual(['port', 'pw']);
    expect(
      undefinedReferences([host], [], {
        variables: [plain('port', '22')],
        environments: [{ id: 'e', name: 'dev', variables: [secret('pw'), plain('host', 'x')] }],
      }),
    ).toEqual([]);
  });
});
