/**
 * Behavioral parser tests ported from the Prisma schema validation suite
 * (prisma/prisma-engines, `psl/psl/tests/validation`), pinned to the engine
 * commit of the bundled @prisma/prisma-schema-wasm. Each case cites its
 * upstream file; schemas are inlined so the tests need no network and no
 * tests-reference/ checkout. See docs/reference-tests.md.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validate, type Diagnostic } from '../../src/index.js';

const REF = '59be4fda12412a79eeb9c2ae727b6aa723593323';
const upstream = (path: string) => `https://github.com/prisma/prisma-engines/blob/${REF}/psl/psl/tests/validation/${path}`;

interface Expected {
  readonly severity: Diagnostic['severity'];
  readonly line: number;
  readonly message: string;
}

interface Case {
  readonly path: string;
  readonly schema: string;
  /** Diagnostics in engine order; message is a substring. Empty means valid without warnings. */
  readonly expected: readonly Expected[];
}

const cases: readonly Case[] = [
  {
    path: 'relations/set_null_is_not_valid_on_required_fields.prisma',
    schema: `model SomeUser {
  id      Int      @id
  profile Profile?
}

model Profile {
  id      Int       @id
  user    SomeUser? @relation(fields: [user_id], references: [id], onUpdate: SetNull, onDelete: SetNull)
  user_id Int       @unique
}
`,
    expected: [
      {
        severity: 'error',
        line: 8,
        message: 'The `onDelete` referential action of a relation must not be set to `SetNull` when a referenced field is required.',
      },
      {
        severity: 'error',
        line: 8,
        message: 'The `onUpdate` referential action of a relation must not be set to `SetNull` when a referenced field is required.',
      },
    ],
  },
  {
    path: 'relations/set_null_still_valid_on_optional_fields.prisma',
    schema: `model SomeUser {
  id      Int      @id
  profile Profile?
}

model Profile {
  id      Int       @id
  user    SomeUser? @relation(fields: [user_id], references: [id], onUpdate: SetNull, onDelete: SetNull)
  user_id Int?      @unique
}
`,
    expected: [],
  },
  {
    path: 'attributes/map/map_must_error_for_relation_fields.prisma',
    schema: `model User {
  id Int @id
  fooId Int
  relationField  Foo @relation(fields: [fooId], references: [id]) @map("custom_name")
}

model Foo {
  id Int @id
}
`,
    expected: [
      { severity: 'error', line: 4, message: 'Error parsing attribute "@map": The attribute `@map` cannot be used on relation fields.' },
    ],
  },
  {
    path: 'attributes/map/duplicate_models_with_map_on_both_sides.prisma',
    schema: `datasource mydb {
    provider = "sqlite"
}

model Dog {
  id Int @id

  @@map("pets")
}

model Cat {
  id Int @id

  @@map("pets")
}
`,
    expected: [
      {
        severity: 'error',
        line: 14,
        message: 'The model with database name "pets" could not be defined because another model or view with this name exists: "Dog"',
      },
    ],
  },
  {
    path: 'models/field_with_same_map_should_not_error.prisma',
    schema: `datasource db {
  provider = "postgresql"
}

model User {
  id   Int    @id
  name String @map("name")
}
`,
    expected: [],
  },
  {
    path: 'models/field_with_non_ascii_ident_should_not_error.prisma',
    schema: `datasource db {
    provider = "postgresql"
}

model A {
    id Int @id @map("_id")
    lööps String[]
}
`,
    expected: [],
  },
  {
    path: 'enums/value_with_non_ascii_ident_should_not_error.prisma',
    schema: `datasource db {
    provider = "postgresql"
}

enum CatVariant {
    lööps
}
`,
    expected: [],
  },
  {
    path: 'attributes/uuid/require_string_column.prisma',
    schema: `datasource db {
  provider = "mysql"
}

model Category {
  id Int @id @default(uuid())
}
`,
    expected: [
      { severity: 'error', line: 6, message: 'Error parsing attribute "@default": The function `uuid()` cannot be used on fields of type `Int`.' },
    ],
  },
  {
    path: 'attributes/cuid/reject_random_int.prisma',
    schema: `datasource db {
  provider = "mysql"
}

model Category {
  id String @id @default(cuid(42))
}
`,
    expected: [
      {
        severity: 'error',
        line: 6,
        message: '`cuid()` takes either no argument, or a single integer argument which is either 1 or 2.',
      },
    ],
  },
  {
    path: 'attributes/index/unknown_field.prisma',
    schema: `model User {
  id Int @id

  @@index([foo,bar])
}
`,
    expected: [
      { severity: 'error', line: 4, message: 'Error validating model "User": The index definition refers to the unknown fields: foo, bar.' },
    ],
  },
  {
    path: 'mysql/set_default_warning.prisma',
    schema: `datasource db {
    provider = "mysql"
}

model A {
    id Int @id
    bs B[]
}

model B {
    id Int   @id
    aId Int? @default(3)
    a   A?   @relation(fields: [aId], references: [id], onUpdate: SetDefault, onDelete: SetDefault)
}
`,
    expected: [
      { severity: 'warning', line: 13, message: 'MySQL does not actually support the `SetDefault` referential action' },
      { severity: 'warning', line: 13, message: 'MySQL does not actually support the `SetDefault` referential action' },
    ],
  },
];

describe('Prisma validation reference cases', () => {
  it('are pinned to the engine commit of the bundled wasm package', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies['@prisma/prisma-schema-wasm']).toMatch(new RegExp(`\\.${REF}$`));
  });

  it.each(cases.map((c) => [c.path, c] as const))('%s', (path, { schema, expected }) => {
    const result = validate(schema);
    const diagnostics = result.ok ? result.warnings : result.error.spans;
    expect(result.ok, upstream(path)).toBe(expected.every((d) => d.severity === 'warning'));
    expect(
      diagnostics.map((d) => ({ severity: d.severity, line: d.startPosition.line, message: d.message })),
      upstream(path),
    ).toEqual(expected.map((d) => ({ ...d, message: expect.stringContaining(d.message) })));
  });
});
