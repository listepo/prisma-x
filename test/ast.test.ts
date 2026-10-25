import { describe, expect, it } from 'vitest';
import { parseSchema, type Field, type Relation } from '../src/index.js';
import { datasource, expectOk } from './helpers.js';

const schema = `${datasource}
enum Role {
  USER
  ADMIN @map("admin")

  @@map("roles")
}

model User {
  id        String   @id @default(uuid())
  email     String   @unique @db.VarChar(255)
  role      Role     @default(USER)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  profile   Profile?
  posts     Post[]
  tags      Tag[]
  mentorId  String?
  mentor    User?    @relation("Mentorship", fields: [mentorId], references: [id])
  mentees   User[]   @relation("Mentorship")
  legacy    Unsupported("circle")?

  @@map("users")
}

model Profile {
  id     Int    @id @default(autoincrement())
  userId String @unique
  user   User   @relation(fields: [userId], references: [id], onDelete: Cascade)
}

model Post {
  id       Int    @id
  authorId String
  author   User   @relation(fields: [authorId], references: [id], onUpdate: Restrict)
}

model Tag {
  id    Int    @id
  name  String
  users User[]

  @@unique([name], name: "tag_name")
}

model Membership {
  group String
  name  String

  @@id([group, name])
}
`;

const ast = expectOk(parseSchema(schema));
const model = (name: string) => ast.models.find((m) => m.name === name)!;
const field = (modelName: string, name: string): Field => model(modelName).fields.find((f) => f.name === name)!;
const relation = (name: string): Relation => ast.relations.find((r) => r.name === name)!;

describe('parseSchema AST', () => {
  it('extracts datasources', () => {
    expect(ast.datasources).toEqual([{ name: 'db', provider: 'postgresql', activeProvider: 'postgresql', schemas: [] }]);
  });

  it('returns no datasources when none is declared', () => {
    expect(expectOk(parseSchema('model A {\n  id Int @id\n}\n')).datasources).toEqual([]);
  });

  it('returns an empty AST for an empty schema', () => {
    expect(expectOk(parseSchema(''))).toEqual({ datasources: [], models: [], enums: [], relations: [] });
  });

  it('extracts enums with mapped names', () => {
    expect(ast.enums).toEqual([
      {
        name: 'Role',
        dbName: 'roles',
        values: [
          { name: 'USER', dbName: null },
          { name: 'ADMIN', dbName: 'admin' },
        ],
      },
    ]);
  });

  it('extracts models in declaration order with mapped names and keys', () => {
    expect(ast.models.map((m) => m.name)).toEqual(['User', 'Profile', 'Post', 'Tag', 'Membership']);
    expect(model('User').dbName).toBe('users');
    expect(model('User').primaryKey).toBeNull();
    expect(model('Membership').primaryKey).toEqual({ name: null, fields: ['group', 'name'] });
    expect(model('Tag').uniqueIndexes).toEqual([{ name: 'tag_name', fields: ['name'] }]);
  });

  it('discriminates field kinds', () => {
    expect(model('User').fields.map((f) => [f.name, f.kind])).toEqual([
      ['id', 'scalar'],
      ['email', 'scalar'],
      ['role', 'enum'],
      ['createdAt', 'scalar'],
      ['updatedAt', 'scalar'],
      ['profile', 'relation'],
      ['posts', 'relation'],
      ['tags', 'relation'],
      ['mentorId', 'scalar'],
      ['mentor', 'relation'],
      ['mentees', 'relation'],
    ]);
  });

  it('omits Unsupported(...) fields, because the engine leaves them out of the DMMF', () => {
    expect(field('User', 'legacy')).toBeUndefined();
  });

  it('maps defaults, native types and flags', () => {
    expect(field('User', 'id').default).toEqual({ kind: 'function', name: 'uuid', args: [4] });
    expect(field('User', 'role').default).toEqual({ kind: 'literal', value: 'USER' });
    expect(field('User', 'createdAt').default).toEqual({ kind: 'function', name: 'now', args: [] });
    expect(field('Profile', 'id').default).toEqual({ kind: 'function', name: 'autoincrement', args: [] });
    expect(field('User', 'updatedAt')).toMatchObject({ isUpdatedAt: true, default: null });
    expect(field('User', 'email')).toMatchObject({
      kind: 'scalar',
      isUnique: true,
      nativeType: { name: 'VarChar', args: ['255'] },
    });
    expect(field('User', 'mentorId')).toMatchObject({ isReadOnly: true, isRequired: false });
  });

  it('exposes relation details on relation fields', () => {
    expect(field('Profile', 'user')).toMatchObject({
      kind: 'relation',
      type: 'User',
      relationName: 'ProfileToUser',
      fromFields: ['userId'],
      toFields: ['id'],
      onDelete: 'Cascade',
      onUpdate: null,
    });
  });

  it('derives one relation per pair of relation fields', () => {
    expect(ast.relations.map((r) => [r.name, r.kind]).sort()).toEqual([
      ['Mentorship', 'one-to-many'],
      ['PostToUser', 'one-to-many'],
      ['ProfileToUser', 'one-to-one'],
      ['TagToUser', 'many-to-many'],
    ]);
  });

  it('puts the foreign-key owner first', () => {
    expect(relation('PostToUser')).toEqual({
      name: 'PostToUser',
      kind: 'one-to-many',
      isSelfRelation: false,
      sides: [
        { model: 'Post', field: 'author', isList: false, isRequired: true },
        { model: 'User', field: 'posts', isList: true, isRequired: true },
      ],
      foreignKey: { fields: ['authorId'], references: ['id'], onDelete: null, onUpdate: 'Restrict' },
    });
  });

  it('handles self relations', () => {
    expect(relation('Mentorship')).toMatchObject({
      isSelfRelation: true,
      sides: [
        { model: 'User', field: 'mentor' },
        { model: 'User', field: 'mentees' },
      ],
      foreignKey: { fields: ['mentorId'], references: ['id'] },
    });
  });

  it('has no foreign key on implicit many-to-many relations', () => {
    expect(relation('TagToUser').foreignKey).toBeNull();
  });

  it('distinguishes same-named relations between different model pairs', () => {
    const source = `${datasource}
model A {
  id  Int @id
  bId Int
  b   B   @relation("link", fields: [bId], references: [id])
  cId Int
  c   C   @relation("link", fields: [cId], references: [id])
}
model B {
  id Int @id
  as A[] @relation("link")
}
model C {
  id Int @id
  as A[] @relation("link")
}
`;
    const relations = expectOk(parseSchema(source)).relations;
    expect(relations.map((r) => r.sides.map((s) => `${s.model}.${s.field}`))).toEqual([
      ['A.b', 'B.as'],
      ['A.c', 'C.as'],
    ]);
  });
});
