import { describe, expect, it } from 'vitest';
import {
  buildIr,
  findRelation,
  parseSchema,
  type IrField,
  type IrForeignKeyRelation,
  type IrManyToManyRelation,
  type IrSchema,
  type SchemaAst,
} from '../../src/index.js';
import { expectOk } from '../helpers.js';

const ds = (provider: string) => `datasource db {\n  provider = "${provider}"\n}\n`;
const ir = (source: string): IrSchema => buildIr(expectOk(parseSchema(source)));
const field = (schema: IrSchema, model: string, name: string): IrField =>
  schema.models.find((m) => m.name === model)!.fields.find((f) => f.name === name)!;
const fkRelation = (schema: IrSchema, name: string) =>
  schema.relations.find((r) => r.name === name) as IrForeignKeyRelation;
const m2mRelation = (schema: IrSchema, name: string) =>
  schema.relations.find((r) => r.name === name) as IrManyToManyRelation;

const blog = ir(`${ds('postgresql')}
/// Roles.
enum Role {
  USER
  ADMIN @map("admin")

  @@map("roles")
}

model User {
  id        Int      @id @default(autoincrement())
  email     String   @unique @map("email_address") @db.VarChar(100)
  role      Role     @default(USER)
  token     String   @default(cuid())
  ref       String   @default(uuid(7))
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  score     Float    @default(dbgenerated("random()"))
  tags      String[]
  posts     Post[]
  profile   Profile?
  bestPost  Post?    @relation("Best", fields: [bestPostId], references: [id])
  bestPostId Int?    @unique
  legacy    Unsupported("circle")?

  @@map("users")
}

model Profile {
  id     Int  @id
  userId Int  @unique
  user   User @relation(fields: [userId], references: [id])
}

model Post {
  id       Int    @id
  authorId Int
  author   User   @relation(fields: [authorId], references: [id], onDelete: Cascade)
  bestOf   User?  @relation("Best")
  slug     String @unique
  tags     Tag[]

  @@index([authorId])
}

model Tag {
  id    Int    @id
  posts Post[]
}

model Membership {
  group String
  name  String
  note  String

  @@id([group, name], name: "groupName", map: "membership_pk")
  @@unique([group, note])
}
`);

describe('buildIr', () => {
  it('takes the provider and schemas from the datasource', () => {
    expect(blog.provider).toBe('postgresql');
    expect(blog.schemas).toEqual([]);
    expect(ir('model A {\n  id Int @id\n}\n').provider).toBeNull();
  });

  it('resolves table and column names from @@map/@map', () => {
    const user = blog.models.find((m) => m.name === 'User')!;
    expect(user.dbName).toBe('users');
    expect(blog.models.find((m) => m.name === 'Tag')!.dbName).toBe('Tag');
    expect(field(blog, 'User', 'email')).toMatchObject({ dbName: 'email_address', isUnique: true });
    expect(field(blog, 'User', 'role')).toMatchObject({ dbName: 'role' });
    expect(field(blog, 'User', 'posts')).not.toHaveProperty('dbName');
  });

  it('maps enums with stored values', () => {
    expect(blog.enums).toEqual([
      {
        name: 'Role',
        dbName: 'roles',
        documentation: 'Roles.',
        values: [
          { name: 'USER', dbName: 'USER' },
          { name: 'ADMIN', dbName: 'admin' },
        ],
      },
    ]);
  });

  it('discriminates fields and keeps declaration order, including unsupported fields', () => {
    const user = blog.models.find((m) => m.name === 'User')!;
    expect(user.fields.map((f) => `${f.name}:${f.kind}`)).toEqual([
      'id:scalar',
      'email:scalar',
      'role:enum',
      'token:scalar',
      'ref:scalar',
      'createdAt:scalar',
      'updatedAt:scalar',
      'score:scalar',
      'tags:scalar',
      'posts:relation',
      'profile:relation',
      'bestPost:relation',
      'bestPostId:scalar',
      'legacy:unsupported',
    ]);
    expect(field(blog, 'User', 'legacy')).toEqual({
      kind: 'unsupported',
      name: 'legacy',
      dbName: 'legacy',
      type: 'circle',
      isList: false,
      isRequired: false,
      documentation: null,
      isIgnored: false,
    });
  });

  it('maps scalar types, native types and flags', () => {
    expect(field(blog, 'User', 'email')).toMatchObject({
      kind: 'scalar',
      type: 'String',
      nativeType: { name: 'VarChar', args: ['100'] },
      isRequired: true,
      isList: false,
    });
    expect(field(blog, 'User', 'tags')).toMatchObject({ type: 'String', isList: true });
    expect(field(blog, 'User', 'updatedAt')).toMatchObject({ isUpdatedAt: true, default: null });
    expect(field(blog, 'User', 'bestPostId')).toMatchObject({ isForeignKey: true, isRequired: false });
    expect(field(blog, 'User', 'email')).toMatchObject({ isForeignKey: false });
    expect(field(blog, 'User', 'role')).toMatchObject({ kind: 'enum', type: 'Role' });
    expect(field(blog, 'User', 'posts')).toEqual({
      kind: 'relation',
      name: 'posts',
      type: 'Post',
      relation: 'PostToUser',
      isList: true,
      isRequired: true,
      documentation: null,
      isIgnored: false,
    });
  });

  it('classifies defaults by who generates the value', () => {
    const defaults = Object.fromEntries(
      ['id', 'role', 'token', 'ref', 'createdAt', 'score'].map((name) => {
        const f = field(blog, 'User', name);
        return [name, f.kind === 'scalar' || f.kind === 'enum' ? f.default : undefined];
      }),
    );
    expect(defaults).toEqual({
      id: { kind: 'function', name: 'autoincrement', args: [], generatedBy: 'database' },
      role: { kind: 'literal', value: 'USER', generatedBy: 'database' },
      token: { kind: 'function', name: 'cuid', args: [1], generatedBy: 'client' },
      ref: { kind: 'function', name: 'uuid', args: [7], generatedBy: 'client' },
      createdAt: { kind: 'function', name: 'now', args: [], generatedBy: 'database' },
      score: { kind: 'function', name: 'dbgenerated', args: ['random()'], generatedBy: 'database' },
    });
  });

  it('resolves primary keys, uniques and indexes with Prisma default names', () => {
    const user = blog.models.find((m) => m.name === 'User')!;
    expect(user.primaryKey).toEqual({ name: null, dbName: 'users_pkey', fields: ['id'] });
    expect(user.uniques.map((u) => u.dbName)).toEqual(['users_email_address_key', 'users_bestPostId_key']);
    const post = blog.models.find((m) => m.name === 'Post')!;
    expect(post.indexes).toEqual([
      { kind: 'normal', name: null, dbName: 'Post_authorId_idx', fields: ['authorId'], isDefinedOnField: false },
    ]);
    const membership = blog.models.find((m) => m.name === 'Membership')!;
    expect(membership.primaryKey).toEqual({ name: 'groupName', dbName: 'membership_pk', fields: ['group', 'name'] });
    expect(membership.uniques).toEqual([
      { kind: 'unique', name: null, dbName: 'Membership_group_note_key', fields: ['group', 'note'], isDefinedOnField: false },
    ]);
  });

  it('truncates default constraint names to the provider limit like Prisma', () => {
    const long = 'a'.repeat(60);
    const schema = ir(`${ds('postgresql')}model M {\n  id Int @id\n  ${long} Int @unique\n}\n`);
    const [unique] = schema.models[0]!.uniques;
    expect(unique!.dbName).toBe(`M_${'a'.repeat(57)}_key`);
    expect(Buffer.byteLength(unique!.dbName)).toBe(63);
    const mysql = ir(`${ds('mysql')}model M {\n  id Int @id\n  ${long} Int @unique\n}\n`);
    expect(mysql.models[0]!.uniques[0]!.dbName).toBe(`M_${'a'.repeat(58)}_key`);
  });

  it('builds one-to-many relations with effective referential actions', () => {
    expect(fkRelation(blog, 'PostToUser')).toEqual({
      kind: 'one-to-many',
      name: 'PostToUser',
      isSelfRelation: false,
      from: { model: 'Post', field: 'author', isList: false, isRequired: true },
      to: { model: 'User', field: 'posts', isList: true, isRequired: true },
      fields: ['authorId'],
      references: ['id'],
      referencesPrimaryKey: true,
      onDelete: 'Cascade',
      onUpdate: 'Cascade',
      dbName: 'Post_authorId_fkey',
      isIgnored: false,
    });
  });

  it('applies Prisma defaults: Restrict for required, SetNull for optional relations', () => {
    expect(fkRelation(blog, 'ProfileToUser')).toMatchObject({ kind: 'one-to-one', onDelete: 'Restrict', onUpdate: 'Cascade' });
    expect(fkRelation(blog, 'Best')).toMatchObject({
      kind: 'one-to-one',
      from: { model: 'User', field: 'bestPost', isRequired: false },
      onDelete: 'SetNull',
      dbName: 'users_bestPostId_fkey',
    });
  });

  it('flags foreign keys that reference a non-primary unique', () => {
    const schema = ir(`${ds('postgresql')}
model A {
  id   Int    @id
  code String @unique
  bs   B[]
}
model B {
  id    Int    @id
  aCode String
  a     A      @relation(fields: [aCode], references: [code])
}
`);
    expect(fkRelation(schema, 'AToB').referencesPrimaryKey).toBe(false);
  });

  it('builds implicit many-to-many relations with Prisma join-table conventions', () => {
    expect(m2mRelation(blog, 'PostToTag')).toEqual({
      kind: 'many-to-many',
      name: 'PostToTag',
      isSelfRelation: false,
      a: { model: 'Post', field: 'tags', isList: true, isRequired: true },
      b: { model: 'Tag', field: 'posts', isList: true, isRequired: true },
      joinTable: {
        dbName: '_PostToTag',
        schema: null,
        columns: [
          { name: 'A', model: 'Post', references: 'id' },
          { name: 'B', model: 'Tag', references: 'id' },
        ],
        uniqueness: { kind: 'primaryKey', dbName: '_PostToTag_AB_pkey' },
        indexDbName: '_PostToTag_B_index',
        foreignKeyDbNames: ['_PostToTag_A_fkey', '_PostToTag_B_fkey'],
      },
      isIgnored: false,
    });
  });

  it('orders many-to-many sides by model name, and by field name for self-relations', () => {
    const schema = ir(`${ds('sqlite')}
model Zebra {
  id      Int     @id
  animals Apple[]
}
model Apple {
  id     Int     @id
  zebras Zebra[]
}
model Person {
  id        Int      @id
  following Person[] @relation("Follows")
  followers Person[] @relation("Follows")
}
`);
    expect(m2mRelation(schema, 'AppleToZebra')).toMatchObject({
      a: { model: 'Apple', field: 'zebras' },
      b: { model: 'Zebra', field: 'animals' },
      joinTable: { uniqueness: { kind: 'unique', dbName: '_AppleToZebra_AB_unique' } },
    });
    expect(m2mRelation(schema, 'Follows')).toMatchObject({
      isSelfRelation: true,
      a: { model: 'Person', field: 'followers' },
      b: { model: 'Person', field: 'following' },
    });
  });

  it('marks self-relations', () => {
    const schema = ir(`${ds('postgresql')}
model Node {
  id       Int    @id
  parentId Int?
  parent   Node?  @relation("Tree", fields: [parentId], references: [id])
  children Node[] @relation("Tree")
}
`);
    expect(fkRelation(schema, 'Tree')).toMatchObject({
      kind: 'one-to-many',
      isSelfRelation: true,
      from: { field: 'parent' },
      to: { field: 'children' },
      onDelete: 'SetNull',
    });
  });

  it('finds relations by end even when names repeat across model pairs', () => {
    const schema = ir(`${ds('postgresql')}
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
`);
    expect(findRelation(schema, 'C', 'as')).toMatchObject({ from: { model: 'A', field: 'c' } });
    expect(findRelation(schema, 'A', 'b')).toMatchObject({ to: { model: 'B' } });
    expect(findRelation(schema, 'A', 'id')).toBeUndefined();
  });

  it('recovers @relation(map: ...), @@ignore models and @ignore fields the engine leaves out', () => {
    const schema = ir(`${ds('postgresql')}
model User {
  id     Int    @id
  secret String @ignore
  posts  Post[]
  logs   Log[]  @ignore
}
model Post {
  id       Int  @id
  authorId Int
  author   User @relation(fields: [authorId], references: [id], map: "fk_post_author")
}
model Log {
  id     Int  @id
  userId Int
  user   User @relation(fields: [userId], references: [id])

  @@ignore
}
`);
    expect(schema.models.map((m) => [m.name, m.isIgnored])).toEqual([
      ['User', false],
      ['Post', false],
      ['Log', true],
    ]);
    expect(schema.models[0]!.fields.map((f) => [f.name, f.isIgnored])).toEqual([
      ['id', false],
      ['secret', true],
      ['posts', false],
      ['logs', true],
    ]);
    expect(fkRelation(schema, 'PostToUser')).toMatchObject({ dbName: 'fk_post_author', isIgnored: false });
    expect(fkRelation(schema, 'LogToUser')).toMatchObject({ dbName: 'Log_userId_fkey', isIgnored: true, from: { model: 'Log' } });
  });

  it('is plain JSON data', () => {
    expect(JSON.parse(JSON.stringify(blog))).toEqual(blog);
  });

  it('synthesizes keys for hand-built ASTs without indexes', () => {
    const ast: SchemaAst = {
      datasources: [],
      enums: [],
      relations: [],
      models: [
        {
          name: 'Item',
          dbName: null,
          schema: null,
          documentation: null,
          primaryKey: null,
          uniqueIndexes: [],
          indexes: [],
          isIgnored: false,
          fields: [
            {
              kind: 'scalar',
              name: 'id',
              dbName: null,
              type: 'Int',
              nativeType: null,
              isList: false,
              isRequired: true,
              isUnique: false,
              isId: true,
              isReadOnly: false,
              isUpdatedAt: false,
              default: null,
              documentation: null,
              isIgnored: false,
            },
          ],
        },
      ],
    };
    expect(buildIr(ast).models[0]!.primaryKey).toEqual({ name: null, dbName: 'Item_pkey', fields: ['id'] });
  });
});
