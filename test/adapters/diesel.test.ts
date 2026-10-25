import { describe, expect, it } from 'vitest';
import { dieselAdapter } from '../../src/adapters/diesel/index.js';
import { codes, diagnosticsText, file, fixture, fixtures, run } from './helpers.js';

const ds = (provider: string) => `datasource db {\n  provider = "${provider}"\n}\n`;

describe('diesel adapter fixtures', () => {
  it.each(fixtures.map((f) => [f.name, f] as const))('%s', async (name, { source }) => {
    const output = run(dieselAdapter, source);
    expect(output.files.map((f) => f.path)).toEqual(['schema.rs', 'models.rs']);
    for (const generated of output.files) {
      await expect(generated.contents).toMatchFileSnapshot(`__snapshots__/diesel/${name}/${generated.path}`);
    }
    await expect(diagnosticsText(output.diagnostics)).toMatchFileSnapshot(`__snapshots__/diesel/${name}/diagnostics.txt`);
  });
});

describe('diesel adapter', () => {
  it('generates table!, joinable!, allow_tables_to_appear_in_same_query! and derives', () => {
    const output = run(dieselAdapter, fixture('blog').source);
    const schema = file(output, 'schema.rs');
    const models = file(output, 'models.rs');
    expect(schema).toContain('diesel::table! {');
    expect(schema).toMatch(/diesel::joinable!\(\w+ -> \w+ \(\w+\)\);/);
    expect(schema).toContain('diesel::allow_tables_to_appear_in_same_query!(');
    expect(models).toContain('#[derive(Queryable, Selectable, Identifiable, Associations, Insertable, Debug, Clone, PartialEq)]');
    expect(models).toMatch(/#\[diesel\(belongs_to\(\w+, foreign_key = \w+\)\)\]/);
  });

  it('declares composite primary keys and skips relation helpers for composite foreign keys', () => {
    const output = run(dieselAdapter, fixture('composite_ids').source);
    expect(file(output, 'schema.rs')).toContain('#[sql_name = "tenant_users"]\n    tenant_user (tenant_id, user_id) {');
    expect(file(output, 'models.rs')).toContain('#[diesel(primary_key(tenant_id, user_id))]');
    expect(output.diagnostics).toContainEqual(
      expect.objectContaining({ severity: 'warning', code: 'RELATION_HELPERS_SKIPPED', model: 'Session', field: 'user' }),
    );
  });

  it('handles self-relations without joinable! and with one belongs_to per parent type', () => {
    const output = run(dieselAdapter, fixture('self_relations').source);
    const schema = file(output, 'schema.rs');
    expect(schema).not.toContain('joinable!(employee -> employee');
    expect(file(output, 'models.rs').match(/belongs_to\(Employee,/g)).toHaveLength(2); // employee + join table
    expect(codes(output.diagnostics)).toEqual(
      expect.arrayContaining(['info:JOINABLE_SKIPPED', 'warning:BELONGS_TO_SKIPPED']),
    );
  });

  it('maps implicit many-to-many relations to a join table', () => {
    const output = run(
      dieselAdapter,
      `${ds('postgresql')}
model Post {
  id   Int   @id
  tags Tag[]
}
model Tag {
  id    Int    @id
  posts Post[]
}
`,
    );
    const schema = file(output, 'schema.rs');
    expect(schema).toContain('#[sql_name = "_PostToTag"]');
    expect(schema).toContain('post_to_tag (a, b) {');
    expect(schema).toContain('#[sql_name = "A"]\n        a -> Int4,');
    expect(schema).toContain('diesel::joinable!(post_to_tag -> post (a));');
    expect(schema).toContain('diesel::joinable!(post_to_tag -> tag (b));');
    expect(file(output, 'models.rs')).toContain('#[diesel(belongs_to(Tag, foreign_key = b))]');
    expect(output.diagnostics).toEqual([]);
  });

  it('generates enums with SQL types per backend', () => {
    const enumSchema = (provider: string) => `${ds(provider)}
enum Status {
  ACTIVE
  ARCHIVED @map("archived")
}
model Item {
  id     Int    @id
  status Status
}
`;
    const pg = run(dieselAdapter, enumSchema('postgresql'));
    expect(file(pg, 'schema.rs')).toContain('#[diesel(postgres_type(name = "Status"))]');
    expect(file(pg, 'schema.rs')).toContain('use super::sql_types::Status;');
    expect(file(pg, 'models.rs')).toContain('Self::Archived => "archived",');
    const mysql = run(dieselAdapter, enumSchema('mysql'));
    expect(file(mysql, 'schema.rs')).toContain('#[diesel(mysql_type(name = "Enum"))]');
    const sqlite = run(dieselAdapter, enumSchema('sqlite'));
    expect(file(sqlite, 'schema.rs')).not.toContain('sql_types');
    expect(file(sqlite, 'schema.rs')).toContain('status -> Text,');
    expect(file(sqlite, 'models.rs')).toContain('#[diesel(sql_type = diesel::sql_types::Text)]');
  });

  it('maps types per database', () => {
    const schema = (provider: string) => `${ds(provider)}
model T {
  id Int      @id
  at DateTime
  n  Decimal?
  j  Json
}
`;
    expect(file(run(dieselAdapter, schema('postgresql')), 'schema.rs')).toContain(
      'at -> Timestamp,\n        n -> Nullable<Numeric>,\n        j -> Jsonb,',
    );
    expect(file(run(dieselAdapter, schema('mysql')), 'schema.rs')).toContain(
      'at -> Datetime,\n        n -> Nullable<Numeric>,\n        j -> Json,',
    );
    const sqlite = run(dieselAdapter, schema('sqlite'));
    expect(file(sqlite, 'schema.rs')).toContain('at -> Timestamp,\n        n -> Nullable<Double>,\n        j -> Text,');
    expect(codes(sqlite.diagnostics)).toEqual(['warning:TYPE_APPROXIMATED', 'info:TYPE_APPROXIMATED', 'info:SQLITE_DATETIME']);
  });

  it('escapes Rust keywords and avoids a column named like its table', () => {
    const output = run(dieselAdapter, fixture('mapped_names').source);
    const schema = file(output, 'schema.rs');
    expect(schema).toContain('#[sql_name = "orders"]\n    order (id) {');
    expect(schema).toContain('#[sql_name = "order_label"]\n        order_ -> Text,');
    expect(schema).toContain('#[sql_name = "type"]\n        type_ -> Text,');
    expect(schema).toContain('#[sql_name = "HTTPLog"]\n    http_log (request_id) {');
  });

  it('reports unsupported types and fields as diagnostics instead of throwing', () => {
    const output = run(dieselAdapter, fixture('unsupported').source);
    const schema = file(output, 'schema.rs');
    expect(schema).not.toContain('location');
    expect(schema).not.toContain('ip ->');
    expect(output.diagnostics.filter((d) => d.code === 'UNSUPPORTED_FIELD').map((d) => d.field)).toEqual(['location', 'area']);
    expect(output.diagnostics.filter((d) => d.code === 'UNSUPPORTED_TYPE').map((d) => d.field)).toEqual(['ip', 'doc', 'flags']);
    expect(output.diagnostics).toContainEqual(expect.objectContaining({ code: 'PRIMARY_KEY_FROM_UNIQUE', model: 'Contact' }));
    expect(schema).toContain('contact (email) {');
  });

  it('skips a model whose primary key has no Diesel type', () => {
    const output = run(
      dieselAdapter,
      `${ds('postgresql')}
model Host {
  ip   String @id @db.Inet
  name String
}
model Other {
  id Int @id
}
`,
    );
    expect(codes(output.diagnostics)).toEqual(['warning:UNSUPPORTED_TYPE', 'error:KEY_COLUMN_OMITTED']);
    expect(file(output, 'schema.rs')).not.toContain('host');
    expect(file(output, 'schema.rs')).not.toContain('allow_tables_to_appear_in_same_query');
  });

  it('reports models without any usable key', () => {
    const output = run(dieselAdapter, `${ds('postgresql')}model Peer {\n  ip String @unique @db.Inet\n}\n`);
    expect(codes(output.diagnostics)).toEqual(['warning:UNSUPPORTED_TYPE', 'error:NO_PRIMARY_KEY']);
  });

  it('keeps @@ignore tables in schema.rs without structs, and skips keyless ones with a warning', () => {
    const output = run(dieselAdapter, fixture('ignored').source);
    const schema = file(output, 'schema.rs');
    const models = file(output, 'models.rs');
    expect(schema).toContain('    tag (id) {');
    expect(schema).toContain('diesel::joinable!(tag_to_user -> tag (a));');
    expect(schema).not.toContain('audit_log');
    expect(models).not.toMatch(/pub struct (Tag|TagToUser|AuditLog)\b/);
    expect(codes(output.diagnostics)).toEqual(['warning:IGNORED_MODEL_SKIPPED', 'info:IGNORED_MODEL', 'warning:JOINABLE_SKIPPED']);
  });

  it('keeps @ignore columns in table! but out of the structs', () => {
    const output = run(dieselAdapter, fixture('ignored').source);
    expect(file(output, 'schema.rs')).toContain('        #[sql_name = "legacy_code"]\n        legacy -> Nullable<Text>,');
    const models = file(output, 'models.rs');
    expect(models).toContain('/// Leaves out `@ignore` columns (`legacy`); select with `User::as_select()`.');
    expect(models).not.toContain('pub legacy');
    // Diesel has no relation fields, so an @ignore relation field changes nothing; foreign-key names are not used.
    expect(models).toContain('#[diesel(belongs_to(Post, foreign_key = pinned_id))]');
    expect(models).not.toContain('fk');
  });

  it('emits New<Model> insert structs that leave database defaults out', () => {
    const models = file(run(dieselAdapter, fixture('blog').source), 'models.rs');
    expect(models).toMatch(/pub struct New\w+ \{/);
    expect(models).toContain('that leaves database defaults to the database.');
  });

  it('reports a missing or unsupported provider as an error and generates nothing', () => {
    const model = 'model A {\n  id Int @id\n}\n';
    expect(run(dieselAdapter, model)).toEqual({ files: [], diagnostics: [expect.objectContaining({ code: 'MISSING_PROVIDER' })] });
    const mongo = run(dieselAdapter, `${ds('mongodb')}model A {\n  id String @id @map("_id")\n}\n`);
    expect(mongo).toEqual({ files: [], diagnostics: [expect.objectContaining({ severity: 'error', code: 'UNSUPPORTED_PROVIDER' })] });
  });

  it('lets options override the provider', () => {
    const output = run(dieselAdapter, 'model A {\n  id Int @id\n}\n', { provider: 'sqlite' });
    expect(output.diagnostics).toEqual([]);
    expect(file(output, 'models.rs')).toContain('check_for_backend(diesel::sqlite::Sqlite)');
    const cockroach = run(dieselAdapter, 'model A {\n  id Int @id\n}\n', { provider: 'cockroachdb' });
    expect(codes(cockroach.diagnostics)).toEqual(['info:COCKROACHDB_AS_POSTGRES']);
  });

  it('is deterministic', () => {
    const { source } = fixture('blog');
    expect(run(dieselAdapter, source)).toEqual(run(dieselAdapter, source));
  });
});
