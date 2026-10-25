import { describe, expect, it } from 'vitest';
import { getDmmf, parseSchema, SchemaError, validate } from '../src/index.js';
import { datasource, expectError, expectOk } from './helpers.js';

const blog = `${datasource}
model User {
  id    Int    @id @default(autoincrement())
  email String @unique
  posts Post[]
}

model Post {
  id       Int  @id
  authorId Int
  author   User @relation(fields: [authorId], references: [id])
}

enum Role {
  USER
  ADMIN
}
`;

describe('validate', () => {
  it('accepts a valid schema', () => {
    const result = validate(blog);
    expect(result).toEqual({ ok: true, value: undefined, warnings: [] });
  });

  it('accepts an empty schema', () => {
    expect(validate('').ok).toBe(true);
    expect(validate('   \n\n').ok).toBe(true);
  });

  it('accepts a schema without a datasource', () => {
    expect(validate('model User {\n  id Int @id\n}\n').ok).toBe(true);
  });

  it('reports syntax errors with code, engine code and spans', () => {
    const source = `${datasource}model User {\n  id Int @id\n`;
    const error = expectError(validate(source));
    expect(error).toBeInstanceOf(SchemaError);
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.engineCode).toBe('P1012');
    expect(error.message).toContain('This line is invalid. It does not start with any known Prisma schema keyword.');
    expect(error.message).toContain('Validation Error Count: 2');
    expect(error.spans).toHaveLength(2);
    const [first] = error.spans;
    expect(first).toMatchObject({
      fileName: 'schema.prisma',
      severity: 'error',
      startPosition: { line: 4, column: 1 },
    });
    expect(source.slice(first!.start, first!.end)).toBe('model User {\n');
  });

  it('strips ANSI colors from messages', () => {
    const error = expectError(validate('nonsense'));
    expect(error.message).not.toMatch(/\u001b\[/);
  });

  it('reports unknown types and points at the type name', () => {
    const source = `${datasource}model User {\n  id Int @id\n  x  Foo\n}\n`;
    const error = expectError(validate(source));
    expect(error.message).toContain('Type "Foo" is neither a built-in type, nor refers to another model, composite type, or enum.');
    expect(error.spans).toHaveLength(1);
    const span = error.spans[0]!;
    expect(source.slice(span.start, span.end)).toBe('Foo');
    expect(span.startPosition).toEqual({ line: 6, column: 6 });
  });

  it('reports duplicate models', () => {
    const source = `${datasource}model User {\n  id Int @id\n}\nmodel User {\n  id Int @id\n}\n`;
    const error = expectError(validate(source));
    expect(error.message).toContain('The model "User" cannot be defined because a model with that name already exists.');
    expect(error.spans).toHaveLength(1);
    expect(error.spans[0]!.startPosition.line).toBe(7);
  });

  it('reports invalid relations (missing @relation fields/references)', () => {
    const source = `${datasource}model User {\n  id    Int    @id\n  posts Post[]\n}\nmodel Post {\n  id     Int  @id\n  author User\n}\n`;
    const error = expectError(validate(source));
    expect(error.spans.map((s) => s.message)).toEqual([
      expect.stringContaining('must specify the `fields` argument'),
      expect.stringContaining('must specify the `references` argument'),
    ]);
  });

  it('reports relations to unknown fields', () => {
    const source = `${datasource}model User {\n  id    Int    @id\n  posts Post[]\n}\nmodel Post {\n  id     Int  @id\n  author User @relation(fields: [nope], references: [id])\n}\n`;
    const error = expectError(validate(source));
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.spans.length).toBeGreaterThan(0);
  });

  it('reports unknown datasource providers', () => {
    const source = 'datasource db {\n  provider = "nope"\n}\n';
    const error = expectError(validate(source));
    expect(error.message).toContain('Datasource provider not known: "nope".');
    expect(error.spans).toHaveLength(1);
    expect(source.slice(error.spans[0]!.start, error.spans[0]!.end)).toBe('"nope"');
  });

  it('rejects the removed datasource url property (Prisma 7)', () => {
    const error = expectError(validate('datasource db {\n  provider = "postgresql"\n  url = env("DB")\n}\n'));
    expect(error.message).toContain('The datasource property `url` is no longer supported in schema files.');
  });

  it('returns warnings on success', () => {
    const source = `generator client {\n  provider        = "prisma-client-js"\n  previewFeatures = ["fullTextSearch"]\n}\n${datasource}`;
    const result = validate(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({ severity: 'warning' });
    expect(result.warnings[0]!.message).toContain('has been renamed to "fullTextSearchPostgres"');
    expect(source.slice(result.warnings[0]!.start, result.warnings[0]!.end)).toBe('["fullTextSearch"]');
  });

  it('returns INVALID_INPUT for non-string input instead of throwing', () => {
    const error = expectError(validate(42 as unknown as string));
    expect(error.code).toBe('INVALID_INPUT');
    expect(expectError(parseSchema(null as unknown as string)).code).toBe('INVALID_INPUT');
  });
});

describe('unicode', () => {
  it('accepts unicode string literals', () => {
    const source = `${datasource}model U {\n  id Int    @id\n  s  String @default("こんにちは 🌍")\n}\n`;
    const field = expectOk(parseSchema(source)).models[0]!.fields[1]!;
    expect(field.default).toEqual({ kind: 'literal', value: 'こんにちは 🌍' });
  });

  it('accepts unicode identifiers', () => {
    const source = `${datasource}model Ünïcødé {\n  id   Int    @id\n  名前 String\n}\n`;
    const ast = expectOk(parseSchema(source));
    expect(ast.models.map((m) => m.name)).toEqual(['Ünïcødé']);
    expect(ast.models[0]!.fields.map((f) => f.name)).toEqual(['id', '名前']);
  });

  it('reports spans in UTF-16 offsets after multi-byte characters', () => {
    // "é" (2 bytes) and "🌍" (4 bytes, a surrogate pair) shift byte offsets but not UTF-16 ones.
    const source = `model U {\n  id Int    @id\n  s  String @default("é🌍")\n  x  Foo\n}\n`;
    const span = expectError(validate(source)).spans[0]!;
    expect(span.start).toBe(source.indexOf('Foo'));
    expect(source.slice(span.start, span.end)).toBe('Foo');
    expect(span.startPosition).toEqual({ line: 4, column: 6 });
  });

  it('getDmmf surfaces the engine panic on a non-ASCII leading model name as ENGINE_PANIC', () => {
    // Engine bug in this wasm build: get_dmmf slices the model name at byte 1.
    const source = `${datasource}model Ünï {\n  id Int @id\n}\n`;
    const error = expectError(getDmmf(source));
    expect(error.code).toBe('ENGINE_PANIC');
    expect(error.message).toContain('is not a char boundary');
    // The module stays usable after a panic.
    expect(expectOk(getDmmf(blog)).datamodel.models).toHaveLength(2);
  });

  it('getDmmf handles unicode field names and non-leading unicode in model names', () => {
    const source = `${datasource}model Café {\n  id   Int    @id\n  名前 String\n}\n`;
    expect(expectOk(getDmmf(source)).datamodel.models[0]!.name).toBe('Café');
  });
});

describe('getDmmf', () => {
  it('returns the datamodel plus the query schema and mappings', () => {
    const dmmf = expectOk(getDmmf(blog));
    expect(dmmf.datamodel.models.map((m) => m.name)).toEqual(['User', 'Post']);
    expect(dmmf.datamodel.enums.map((e) => e.name)).toEqual(['Role']);
    expect(dmmf.schema).toEqual(expect.objectContaining({ outputObjectTypes: expect.any(Object) }));
    expect(dmmf.mappings).toEqual(expect.objectContaining({ modelOperations: expect.any(Array) }));
  });

  it('returns an empty datamodel for an empty schema', () => {
    const dmmf = expectOk(getDmmf(''));
    expect(dmmf.datamodel).toEqual({ enums: [], models: [], types: [], indexes: [] });
  });

  it('fails with the same validation error as validate', () => {
    const source = `${datasource}model User {\n  id Int @id\n  x Foo\n}\n`;
    expect(expectError(getDmmf(source)).message).toBe(expectError(validate(source)).message);
  });
});

describe('huge input', () => {
  const count = 500;
  let source = datasource;
  for (let i = 0; i < count; i++) {
    const next = (i + 1) % count;
    source +=
      `model M${i} {\n  id       Int @id @default(autoincrement())\n  name     String\n` +
      `  nextId   Int?  @unique\n  next     M${next}? @relation("R${i}", fields: [nextId], references: [id])\n` +
      `  previous M${(i + count - 1) % count}? @relation("R${(i + count - 1) % count}")\n}\n`;
  }

  it('parses 500 models with 500 relations', () => {
    const ast = expectOk(parseSchema(source));
    expect(ast.models).toHaveLength(count);
    expect(ast.relations).toHaveLength(count);
    expect(ast.relations.every((r) => r.kind === 'one-to-one')).toBe(true);
  });

  it('builds the full DMMF for 500 models', () => {
    expect(expectOk(getDmmf(source)).datamodel.models).toHaveLength(count);
  });

  it('reports an error deep inside a huge schema at the right line', () => {
    const broken = `${source}model Broken {\n  id Int @id\n  bad Nope\n}\n`;
    const error = expectError(validate(broken));
    expect(error.spans).toHaveLength(1);
    expect(error.spans[0]!.startPosition.line).toBe(broken.split('\n').length - 2);
  });
});
