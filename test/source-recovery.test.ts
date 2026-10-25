/**
 * The source scan rebuilds datamodel entries for what the engine drops. Where
 * the engine reports everything, the rebuilt entries must equal the engine's
 * own: on the fixtures, on a schema that exercises every recovered attribute,
 * and on every valid schema of Prisma's validation suite when tests-reference/
 * is checked out (see docs/reference-tests.md).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { DmmfDatamodel, DmmfField, DmmfIndex, DmmfModel } from '../src/dmmf.js';
import { wasmGetDatamodel, wasmValidate } from '../src/internal/wasm.js';
import { recoverModels } from '../src/source-recovery.js';
import { scanModels } from '../src/source-scan.js';
import { fixtures } from './adapters/helpers.js';

const KITCHEN = `datasource db {
  provider = "postgresql"
}

enum Role {
  USER
  ADMIN
}

///   Doc with spaces.
// a plain comment between doc and block
/// Second line.
model Kitchen {
  id        BigInt    @id @default(autoincrement())
  /// field doc
  i         Int       @default(-5) /// trailing doc
  f         Float     @default(1.5)
  d         Decimal   @default(2.25)
  bi        BigInt    @default(42)
  b         Boolean   @default(false)
  s         String    @default("a\\"b\\\\c // not a comment")
  r         Role      @default(ADMIN)
  dt        DateTime  @default("2020-01-01T00:00:00Z")
  j         Json      @default("{\\"a\\": 1}")
  ints      Int[]     @default([1, 2])
  roles     Role[]    @default([USER])
  u1        String    @default(uuid(7)) @unique(map: "u1_key")
  u2        String    @default(cuid(2))
  g         String    @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  v         String    @db.VarChar(10)
  dec       Decimal   @db.Decimal(10, 2)
  ts        DateTime  @default(now()) @db.Timestamptz(6)
  upd       DateTime  @updatedAt
  by        Bytes     @default("AQID")
  o         Int?      @map(name: "o_col")
  parentId  BigInt?
  parent    Kitchen?  @relation("Tree", fields: [parentId], references: [id], onDelete: SetNull, onUpdate: NoAction)
  children  Kitchen[] @relation(name: "Tree")
  other     Other     @relation(fields: [otherA, otherB], references: [a, b], map: "kfk")
  otherA    Int
  otherB    Int

  @@unique([i, f], name: "iF", map: "i_f_key")
  @@unique(fields: [v])
  @@index([s(sort: Desc), b], map: "s_b_idx")
  @@index([dt, i], type: Brin) /* block comment */
  @@map("kitchens")
}

model Other {
  a Int
  b Int
  k Kitchen[]

  @@id([a, b], map: "other_pk", name: "ab")
}
`;

/** Where the engine attaches `///` and block comments. */
const COMMENTS = `/// detached by the blank line

/// m2
model A {
  id Int @id
  /// d1

  a Int
  /* b1 */ /// d2
  b Int
  /// d3
  // plain
  c Int /// t1
  /* x */
  /// d4
  d Int /* inline */
  e Int
  /// d5
  @@map("aa")
  f Int
}

/* mb */
model B {
  id Int @id
}

/// detached too

model C {
  id Int @id
}
`;

function datamodel(source: string): DmmfDatamodel {
  const result = wasmGetDatamodel(source);
  if (!result.ok) throw new Error(`engine failed: ${result.kind}`);
  return JSON.parse(result.output) as DmmfDatamodel;
}

/** The parts of a field the AST uses. */
function fieldShape(f: DmmfField) {
  return {
    name: f.name,
    dbName: f.dbName ?? null,
    kind: f.kind,
    type: f.type,
    isList: f.isList,
    isRequired: f.isRequired,
    isUnique: f.isUnique,
    isId: f.isId,
    isReadOnly: f.isReadOnly,
    isUpdatedAt: f.isUpdatedAt,
    nativeType: f.nativeType,
    default: f.default ?? null,
    documentation: f.documentation ?? null,
    relationName: f.relationName ?? null,
    relationFromFields: f.relationFromFields ?? null,
    relationToFields: f.relationToFields ?? null,
    relationOnDelete: f.relationOnDelete ?? null,
    relationOnUpdate: f.relationOnUpdate ?? null,
  };
}

function modelShape(m: DmmfModel, fields: readonly DmmfField[]) {
  return {
    name: m.name,
    dbName: m.dbName,
    schema: m.schema ?? null,
    documentation: m.documentation ?? null,
    primaryKey: m.primaryKey,
    uniqueFields: m.uniqueFields,
    uniqueIndexes: m.uniqueIndexes,
    fields: fields.map(fieldShape),
  };
}

const indexShape = (i: DmmfIndex) => ({
  type: i.type,
  isDefinedOnField: i.isDefinedOnField,
  name: i.name ?? null,
  dbName: i.dbName ?? null,
  fields: i.fields.map((f) => f.name),
});

/** Compares recovered models with the engine's; fields the engine omits are not compared. */
function expectRecoveryMatchesEngine(source: string): void {
  const engine = datamodel(source);
  const recovered = new Map(recoverModels(source, engine.enums.map((e) => e.name), engine.types.map((t) => t.name)).map((r) => [r.model.name, r]));
  for (const model of engine.models) {
    const r = recovered.get(model.name);
    expect(r, `model ${model.name}`).toBeDefined();
    const names = new Set(model.fields.map((f) => f.name));
    expect(modelShape(r!.model, r!.model.fields.filter((f) => names.has(f.name)))).toEqual(modelShape(model, model.fields));
    expect(r!.indexes.map(indexShape)).toEqual(engine.indexes.filter((i) => i.model === model.name).map(indexShape));
  }
}

const REFERENCE = fileURLToPath(new URL('../tests-reference/psl/psl/tests/validation/', import.meta.url));

function referenceSchemas(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return referenceSchemas(path);
    return name.endsWith('.prisma') ? [path] : [];
  });
}

describe('source recovery', () => {
  it('matches the engine on a schema with every recovered attribute', () => {
    expectRecoveryMatchesEngine(KITCHEN);
  });

  it('attaches doc and block comments like the engine', () => {
    expectRecoveryMatchesEngine(COMMENTS);
    expect(recoverModels(COMMENTS, [])[0]!.model.fields.find((f) => f.name === 'd')?.documentation).toBe('x\nd4\ninline');
  });

  it.each(fixtures.map((f) => [f.name, f.source] as const))('matches the engine on fixture %s', (_, source) => {
    expectRecoveryMatchesEngine(source);
  });

  it.skipIf(!existsSync(REFERENCE))('matches the engine on every valid schema of the Prisma validation suite', () => {
    let checked = 0;
    for (const path of referenceSchemas(REFERENCE)) {
      // Upstream files end with the expected errors as `//` comments; valid ones have none.
      const source = readFileSync(path, 'utf8');
      if (!wasmValidate(source).ok) continue;
      const result = wasmGetDatamodel(source);
      if (!result.ok) continue;
      try {
        expectRecoveryMatchesEngine(source);
      } catch (error) {
        throw new Error(`${path}: ${(error as Error).message}`, { cause: error });
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('recovers @@ignore models, @ignore fields and foreign-key names', () => {
    const source = `datasource db {
  provider = "postgresql"
}

model User {
  id     Int    @id
  posts  Post[]
  logs   Log[]  @ignore
  secret String @default("x") @map("secret_col") @ignore
}

model Post {
  id       Int  @id
  authorId Int
  author   User @relation(fields: [authorId], references: [id], map: "fk_post_author", onDelete: Cascade)
}

/// Raw log rows, no key.
model Log {
  userId Int
  at     DateTime @default(now())
  user   User     @relation(fields: [userId], references: [id], map: "fk_log_user")

  @@index([userId])
  @@ignore
  @@map("logs")
}
`;
    const [user, post, log] = recoverModels(source, []);
    expect(user!.ignoredFields).toEqual(new Set(['logs', 'secret']));
    expect(user!.model.fields.find((f) => f.name === 'secret')).toMatchObject({ dbName: 'secret_col', default: 'x' });
    expect(post!.foreignKeyNames).toEqual(new Map([['author', 'fk_post_author']]));
    expect(log).toMatchObject({ isIgnored: true, foreignKeyNames: new Map([['user', 'fk_log_user']]) });
    expect(log!.model).toMatchObject({ dbName: 'logs', documentation: 'Raw log rows, no key.', primaryKey: null });
    expect(log!.model.fields.map((f) => [f.name, f.kind, f.isReadOnly])).toEqual([
      ['userId', 'scalar', true],
      ['at', 'scalar', false],
      ['user', 'object', false],
    ]);
    expect(log!.indexes.map(indexShape)).toEqual([{ type: 'normal', isDefinedOnField: false, name: null, dbName: null, fields: ['userId'] }]);
  });
});

describe('source scan', () => {
  it('ignores comments and keywords inside strings, and attaches doc comments', () => {
    const [model, ...rest] = scanModels(`// model Fake {
/// Doc.
model A {
  // b Int
  a String @default("model B { c Int }") // trailing
  /// Field doc.

  c Int

  @@map("a_table") // @@ignore
}
enum E {
  X
}
`);
    expect(rest).toEqual([]);
    expect(model).toMatchObject({ name: 'A', documentation: 'Doc.', attributes: [{ name: 'map' }] });
    // Inside a model, doc comments carry over blank lines, like in the engine.
    expect(model!.fields.map((f) => [f.name, f.documentation])).toEqual([
      ['a', null],
      ['c', 'Field doc.'],
    ]);
  });

  it('reads Unsupported types, arity and dotted attribute names', () => {
    const [model] = scanModels('model A {\n  p Unsupported("point")[] @db.Char(3)\n  q Int? @default(dbgenerated("1"))\n}\n');
    expect(model!.fields).toEqual([
      {
        name: 'p',
        type: 'Unsupported',
        unsupportedType: 'point',
        isList: true,
        isOptional: false,
        attributes: [{ name: 'db.Char', args: [{ name: null, value: { kind: 'number', text: '3' } }] }],
        documentation: null,
      },
      {
        name: 'q',
        type: 'Int',
        unsupportedType: null,
        isList: false,
        isOptional: true,
        attributes: [
          {
            name: 'default',
            args: [{ name: null, value: { kind: 'call', name: 'dbgenerated', args: [{ name: null, value: { kind: 'string', value: '1' } }] } }],
          },
        ],
        documentation: null,
      },
    ]);
  });
});
