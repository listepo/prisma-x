/**
 * A minimal scan of model fields in the schema source.
 *
 * The engine's DMMF omits `Unsupported("...")` fields entirely. This scan
 * recovers them (name, database type, arity, `@map`) and the declaration order
 * of all fields, so they can be put back in place. It only runs on schemas the
 * engine has already validated, so it does not need to report syntax errors.
 */

export interface DeclaredField {
  readonly name: string;
  /** Quoted type of `Unsupported("...")`; null for every other field. */
  readonly unsupportedType: string | null;
  /** Arity of an `Unsupported` field; always false for other fields. */
  readonly isList: boolean;
  readonly isOptional: boolean;
  /** Column name from `@map("...")`, if any. */
  readonly dbName: string | null;
}

/** Removes `//` and `///` comments, leaving string literals intact. */
function stripComments(source: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      out += ch;
      if (ch === '\\') out += source[++i] ?? '';
      else if (ch === '"' || ch === '\n') inString = false;
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      out += '\n';
    } else {
      out += ch;
    }
  }
  return out;
}

const STRING = String.raw`"((?:[^"\\]|\\.)*)"`;
const BLOCK_START = /^(?:model|view)\s+(\S+?)\s*\{$/u;
const UNSUPPORTED = new RegExp(String.raw`^(\S+)\s+Unsupported\(\s*${STRING}\s*\)(\[\]|\?)?`, 'u');
const FIELD = /^([^\s@]+)\s+\S/u;
const MAP = new RegExp(String.raw`(?:^|\s)@map\(\s*(?:name\s*:\s*)?${STRING}`, 'u');

function unescape(text: string): string {
  return text.replace(/\\(.)/gu, '$1');
}

/** Returns, per model or view name, its fields in declaration order. */
export function scanDeclaredFields(source: string): Map<string, DeclaredField[]> {
  const models = new Map<string, DeclaredField[]>();
  let current: DeclaredField[] | null = null;
  for (const rawLine of stripComments(source).split('\n')) {
    const line = rawLine.trim();
    if (current === null) {
      const start = BLOCK_START.exec(line);
      if (start?.[1] !== undefined) {
        current = [];
        models.set(start[1], current);
      }
      continue;
    }
    if (line.startsWith('}')) {
      current = null;
      continue;
    }
    if (line === '' || line.startsWith('@')) continue;
    const map = MAP.exec(line);
    const dbName = map?.[1] === undefined ? null : unescape(map[1]);
    const unsupported = UNSUPPORTED.exec(line);
    if (unsupported?.[1] !== undefined && unsupported[2] !== undefined) {
      current.push({
        name: unsupported[1],
        unsupportedType: unescape(unsupported[2]),
        isList: unsupported[3] === '[]',
        isOptional: unsupported[3] === '?',
        dbName,
      });
      continue;
    }
    const field = FIELD.exec(line);
    if (field?.[1] !== undefined) {
      current.push({ name: field[1], unsupportedType: null, isList: false, isOptional: false, dbName });
    }
  }
  return models;
}
