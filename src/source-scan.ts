/**
 * A tolerant scanner for the `model` and `view` blocks of a schema source.
 *
 * The engine's datamodel leaves out what Prisma Client does not see:
 * `Unsupported("...")` fields, `@ignore` fields, `@@ignore` models and custom
 * foreign-key names (`@relation(map: "...")`). This scanner reads blocks,
 * fields and attributes (with their arguments) back from the source so they
 * can be recovered (see `source-recovery.ts`). It handles `//`, `///` and
 * `/* *\/` comments, string escapes and nested brackets. It only runs on
 * schemas the engine has already validated, so it reports no errors and never
 * throws: anything it does not understand is skipped.
 */

export type ScanValue =
  | { readonly kind: 'string'; readonly value: string }
  /** `text` is the literal as written, e.g. `-5` or `2.25`. */
  | { readonly kind: 'number'; readonly text: string }
  /** A bare identifier: `true`, `Cascade`, an enum value or a field name. */
  | { readonly kind: 'constant'; readonly value: string }
  | { readonly kind: 'array'; readonly items: readonly ScanValue[] }
  /** A call such as `uuid(7)` or a field reference with arguments such as `title(sort: Desc)`. */
  | { readonly kind: 'call'; readonly name: string; readonly args: readonly ScanArgument[] };

export interface ScanArgument {
  /** Name of a named argument (`map: ...`), or null for a positional one. */
  readonly name: string | null;
  readonly value: ScanValue;
}

export interface ScanAttribute {
  /** Name without `@`/`@@`, e.g. `relation`, `map` or `db.VarChar` (prefixed with the datasource name). */
  readonly name: string;
  readonly args: readonly ScanArgument[];
}

export interface ScanField {
  readonly name: string;
  /** Type name; `Unsupported` for `Unsupported("...")`. */
  readonly type: string;
  /** Quoted type of `Unsupported("...")`; null for every other field. */
  readonly unsupportedType: string | null;
  readonly isList: boolean;
  readonly isOptional: boolean;
  readonly attributes: readonly ScanAttribute[];
  /** `///` comments above the field and on its line, or null. */
  readonly documentation: string | null;
}

export interface ScanModel {
  readonly keyword: 'model' | 'view';
  readonly name: string;
  readonly documentation: string | null;
  readonly fields: readonly ScanField[];
  /** Block attributes (`@@...`). */
  readonly attributes: readonly ScanAttribute[];
}

export interface ScanSchema {
  /** Name of the `datasource` block, the prefix of native type attributes (`@db.VarChar`). */
  readonly datasource: string | null;
  readonly models: readonly ScanModel[];
}

type Token =
  | { readonly kind: 'ident'; readonly text: string }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'number'; readonly text: string }
  | { readonly kind: 'punct'; readonly text: string }
  | { readonly kind: 'doc'; readonly text: string }
  | { readonly kind: 'newline' };

const IDENT_START = /[\p{L}_]/u;
const IDENT_PART = /[\p{L}\p{N}_-]/u;
const NUMBER = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/u;

/** Decodes a string literal body; Prisma strings use JSON escapes. */
function unquote(body: string): string {
  try {
    return JSON.parse(`"${body}"`) as string;
  } catch {
    return body.replace(/\\(.)/gu, '$1');
  }
}

/**
 * Splits the source into tokens. Newlines are only emitted outside `(...)` and
 * `[...]`, so a field or attribute is always one line of tokens. Lines that
 * hold nothing but a `//` comment produce no newline, so they do not detach
 * doc comments from what follows.
 */
function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let depth = 0;
  let i = 0;
  const lineIsEmpty = () => tokens.length === 0 || tokens[tokens.length - 1]?.kind === 'newline';
  while (i < source.length) {
    const ch = source[i] ?? '';
    if (ch === '\n') {
      if (depth === 0) tokens.push({ kind: 'newline' });
      i++;
    } else if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '﻿') {
      i++;
    } else if (ch === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      const isDoc = source[i + 2] === '/';
      if (isDoc) {
        tokens.push({ kind: 'doc', text: source.slice(i + 3, stop).trim() });
        i = stop;
      } else {
        const standalone = lineIsEmpty();
        i = standalone && end !== -1 ? end + 1 : stop;
      }
    } else if (ch === '/' && source[i + 1] === '*') {
      // The engine treats block comments as documentation.
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end;
      tokens.push({ kind: 'doc', text: source.slice(i + 2, stop).trim() });
      i = end === -1 ? source.length : end + 2;
    } else if (ch === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== '"' && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1;
      tokens.push({ kind: 'string', value: unquote(source.slice(i + 1, Math.min(j, source.length))) });
      i = source[j] === '"' ? j + 1 : j;
    } else if (ch === '@') {
      const isBlock = source[i + 1] === '@';
      tokens.push({ kind: 'punct', text: isBlock ? '@@' : '@' });
      i += isBlock ? 2 : 1;
    } else if (/[\d-]/u.test(ch) && NUMBER.test(source.slice(i, i + 64))) {
      const text = NUMBER.exec(source.slice(i, i + 64))?.[0] ?? ch;
      tokens.push({ kind: 'number', text });
      i += text.length;
    } else if (IDENT_START.test(ch)) {
      let j = i + 1;
      while (j < source.length && IDENT_PART.test(source[j] ?? '')) j++;
      tokens.push({ kind: 'ident', text: source.slice(i, j) });
      i = j;
    } else {
      if (ch === '(' || ch === '[') depth++;
      else if ((ch === ')' || ch === ']') && depth > 0) depth--;
      tokens.push({ kind: 'punct', text: ch });
      i++;
    }
  }
  return tokens;
}

class Parser {
  private i = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  private peek(offset = 0): Token | undefined {
    return this.tokens[this.i + offset];
  }

  private isPunct(text: string, offset = 0): boolean {
    const token = this.peek(offset);
    return token?.kind === 'punct' && token.text === text;
  }

  private atLineEnd(): boolean {
    const token = this.peek();
    return token === undefined || token.kind === 'newline' || (token.kind === 'punct' && token.text === '}');
  }

  /**
   * Pending doc comments (`///` and `/* *\/`). Like in the engine, a blank line
   * detaches them from the next block, but inside a model they carry over
   * blank lines and `@@` attributes to the next field.
   */
  private docs: string[] = [];

  private takeDocs(): string | null {
    const text = this.docs.length === 0 ? null : this.docs.join('\n');
    this.docs = [];
    return text;
  }

  /** Handles a newline or doc token between items; returns false for anything else. */
  private skipTrivia(topLevel: boolean): boolean {
    const token = this.peek();
    if (token?.kind === 'doc') {
      this.docs.push(token.text);
      this.i++;
      return true;
    }
    if (token?.kind === 'newline') {
      if (topLevel && (this.peek(-1)?.kind === 'newline' || this.peek(-1) === undefined)) this.docs = [];
      this.i++;
      return true;
    }
    return false;
  }

  parseSchema(): ScanSchema {
    const models: ScanModel[] = [];
    let datasource: string | null = null;
    while (this.i < this.tokens.length) {
      if (this.skipTrivia(true)) continue;
      const keyword = this.peek();
      const name = this.peek(1);
      if (keyword?.kind === 'ident' && name?.kind === 'ident' && this.isPunct('{', 2)) {
        this.i += 3;
        if (keyword.text === 'model' || keyword.text === 'view') {
          models.push(this.parseModel(keyword.text, name.text, this.takeDocs()));
        } else {
          if (keyword.text === 'datasource') datasource ??= name.text;
          this.docs = [];
          this.skipBlock();
        }
        continue;
      }
      this.docs = [];
      this.i++;
    }
    return { datasource, models };
  }

  private skipBlock(): void {
    let depth = 1;
    while (this.i < this.tokens.length && depth > 0) {
      if (this.isPunct('{')) depth++;
      else if (this.isPunct('}')) depth--;
      this.i++;
    }
  }

  private skipLine(): void {
    while (!this.atLineEnd()) this.i++;
  }

  private parseModel(keyword: 'model' | 'view', name: string, documentation: string | null): ScanModel {
    const fields: ScanField[] = [];
    const attributes: ScanAttribute[] = [];
    this.docs = [];
    while (this.i < this.tokens.length) {
      if (this.isPunct('}')) {
        this.i++;
        break;
      }
      if (this.skipTrivia(false)) continue;
      const token = this.peek();
      if (this.isPunct('@@')) {
        this.i++;
        const attribute = this.parseAttribute();
        if (attribute !== null) attributes.push(attribute);
      } else if (token?.kind === 'ident') {
        const field = this.parseField(token.text);
        if (field !== null) fields.push(field);
      }
      this.skipLine();
    }
    return { keyword, name, documentation, fields, attributes };
  }

  private parseField(name: string): ScanField | null {
    const docs = this.docs;
    this.docs = [];
    this.i++;
    const type = this.peek();
    if (type?.kind !== 'ident') return null;
    this.i++;
    let unsupportedType: string | null = null;
    if (this.isPunct('(')) {
      const [first] = this.parseArguments();
      if (type.text === 'Unsupported' && first?.value.kind === 'string') unsupportedType = first.value.value;
    }
    let isList = false;
    let isOptional = false;
    if (this.isPunct('[') && this.isPunct(']', 1)) {
      isList = true;
      this.i += 2;
    }
    if (this.isPunct('?')) {
      isOptional = true;
      this.i++;
    }
    const attributes: ScanAttribute[] = [];
    while (!this.atLineEnd()) {
      const token = this.peek();
      if (this.isPunct('@')) {
        this.i++;
        const attribute = this.parseAttribute();
        if (attribute !== null) attributes.push(attribute);
      } else {
        // A trailing `///` comment belongs to the field, like in the engine.
        if (token?.kind === 'doc') docs.push(token.text);
        this.i++;
      }
    }
    return {
      name,
      type: type.text,
      unsupportedType,
      isList,
      isOptional,
      attributes,
      documentation: docs.length === 0 ? null : docs.join('\n'),
    };
  }

  /** Parses `name(.name)*(args)?` after `@` or `@@`. */
  private parseAttribute(): ScanAttribute | null {
    const first = this.peek();
    if (first?.kind !== 'ident') return null;
    this.i++;
    let name = first.text;
    while (this.isPunct('.') && this.peek(1)?.kind === 'ident') {
      name += `.${(this.peek(1) as { text: string }).text}`;
      this.i += 2;
    }
    return { name, args: this.isPunct('(') ? this.parseArguments() : [] };
  }

  /** Parses `( [name:] value, ... )`, starting at `(`. */
  private parseArguments(): ScanArgument[] {
    const args: ScanArgument[] = [];
    this.i++;
    while (this.i < this.tokens.length && !this.isPunct(')')) {
      if (this.isPunct(',')) {
        this.i++;
        continue;
      }
      const token = this.peek();
      let name: string | null = null;
      if (token?.kind === 'ident' && this.isPunct(':', 1)) {
        name = token.text;
        this.i += 2;
      }
      const start = this.i;
      const value = this.parseValue();
      if (value !== null) args.push({ name, value });
      if (this.i === start) this.i++;
    }
    this.i++;
    return args;
  }

  private parseValue(): ScanValue | null {
    const token = this.peek();
    if (token === undefined) return null;
    switch (token.kind) {
      case 'string':
        this.i++;
        return { kind: 'string', value: token.value };
      case 'number':
        this.i++;
        return { kind: 'number', text: token.text };
      case 'ident': {
        this.i++;
        let name = token.text;
        while (this.isPunct('.') && this.peek(1)?.kind === 'ident') {
          name += `.${(this.peek(1) as { text: string }).text}`;
          this.i += 2;
        }
        return this.isPunct('(') ? { kind: 'call', name, args: this.parseArguments() } : { kind: 'constant', value: name };
      }
      case 'punct':
        if (token.text !== '[') return null;
        return { kind: 'array', items: this.parseArray() };
      default:
        return null;
    }
  }

  private parseArray(): ScanValue[] {
    const items: ScanValue[] = [];
    this.i++;
    while (this.i < this.tokens.length && !this.isPunct(']')) {
      if (this.isPunct(',')) {
        this.i++;
        continue;
      }
      const start = this.i;
      const value = this.parseValue();
      if (value !== null) items.push(value);
      if (this.i === start) this.i++;
    }
    this.i++;
    return items;
  }
}

/** Scans the datasource name and the `model` and `view` blocks of a schema, in declaration order. */
export function scanSchema(source: string): ScanSchema {
  return new Parser(tokenize(source)).parseSchema();
}

/** Scans the `model` and `view` blocks of a schema, in declaration order. */
export function scanModels(source: string): readonly ScanModel[] {
  return scanSchema(source).models;
}
