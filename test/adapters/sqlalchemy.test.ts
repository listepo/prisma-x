import { describe, expect, it } from 'vitest';
import { dieselAdapter } from '../../src/adapters/diesel/index.js';
import { sqlalchemyAdapter } from '../../src/adapters/sqlalchemy/index.js';
import { codes, diagnosticsText, file, fixture, fixtures, irOf, run } from './helpers.js';

const ds = (provider: string) => `datasource db {\n  provider = "${provider}"\n}\n`;

describe('sqlalchemy adapter fixtures', () => {
  it.each(fixtures.map((f) => [f.name, f] as const))('%s', async (name, { source }) => {
    const output = run(sqlalchemyAdapter, source);
    expect(output.files.map((f) => f.path)).toEqual(['models.py']);
    await expect(output.files[0]!.contents).toMatchFileSnapshot(`__snapshots__/sqlalchemy/${name}/models.py`);
    await expect(diagnosticsText(output.diagnostics)).toMatchFileSnapshot(`__snapshots__/sqlalchemy/${name}/diagnostics.txt`);
  });
});

describe('sqlalchemy adapter', () => {
  it('consumes the same IR as the Diesel adapter without changing it', () => {
    for (const { source } of fixtures) {
      const ir = irOf(source);
      const before = structuredClone(ir);
      dieselAdapter.generate(ir);
      sqlalchemyAdapter.generate(ir);
      expect(ir).toEqual(before);
    }
  });

  it('uses declarative 2.0 mappings', () => {
    const models = file(run(sqlalchemyAdapter, fixture('blog').source), 'models.py');
    expect(models).toContain('class Base(DeclarativeBase):');
    expect(models).toMatch(/: Mapped\[int\] = mapped_column\(sa\.Integer\(\), primary_key=True, autoincrement=True\)/);
    expect(models).toMatch(/= relationship\(back_populates="\w+"/);
  });

  it('maps implicit many-to-many relations to association tables', () => {
    const models = file(
      run(
        sqlalchemyAdapter,
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
      ),
      'models.py',
    );
    expect(models).toContain('post_to_tag_table = sa.Table(\n    "_PostToTag",\n    Base.metadata,');
    expect(models).toContain('sa.Column("A", sa.ForeignKey("Post.id", ondelete="CASCADE", onupdate="CASCADE", name="_PostToTag_A_fkey"), primary_key=True),');
    expect(models).toContain('sa.Index("_PostToTag_B_index", "B"),');
    expect(models).toContain('tags: Mapped[list[Tag]] = relationship(secondary=post_to_tag_table, back_populates="posts")');
  });

  it('uses a unique constraint instead of a primary key on join tables outside PostgreSQL', () => {
    const models = file(run(sqlalchemyAdapter, fixture('many_to_many').source), 'models.py');
    expect(models).toMatch(/sa\.UniqueConstraint\("A", "B", name="_\w+_AB_unique"\)/);
  });

  it('stores enum values rather than member names', () => {
    const models = file(run(sqlalchemyAdapter, fixture('mapped_names').source), 'models.py');
    expect(models).toContain('class OrderState(str, enum.Enum):\n    pending = "PENDING"');
    expect(models).toContain('sa.Enum(OrderState, name="order_state", values_callable=_enum_values), server_default="PENDING"');
  });

  it('maps composite keys and composite foreign keys through __table_args__', () => {
    const models = file(run(sqlalchemyAdapter, fixture('composite_ids').source), 'models.py');
    expect(models).toContain('sa.PrimaryKeyConstraint("tenant_id", "user_id", name="tenant_users_pk"),');
    expect(models).toContain(
      'sa.ForeignKeyConstraint(["tenant_id", "user_id"], ["tenant_users.tenant_id", "tenant_users.user_id"], ondelete="CASCADE", onupdate="CASCADE", name="Session_tenant_id_user_id_fkey"),',
    );
  });

  it('disambiguates self-relations with foreign_keys, remote_side and explicit joins', () => {
    const models = file(run(sqlalchemyAdapter, fixture('self_relations').source), 'models.py');
    expect(models).toContain('remote_side="[Employee.id]"');
    expect(models).toContain('primaryjoin=lambda: Employee.id == follows_table.c.A, secondaryjoin=lambda: Employee.id == follows_table.c.B');
  });

  it('maps unique-only models through __mapper_args__ and reports omitted fields', () => {
    const output = run(sqlalchemyAdapter, fixture('unsupported').source);
    expect(file(output, 'models.py')).toContain('__mapper_args__ = {"primary_key": [email]}');
    expect(file(output, 'models.py')).not.toContain('relationship');
    expect(codes(output.diagnostics)).toEqual([
      'warning:NATIVE_TYPE_FALLBACK',
      'warning:UNSUPPORTED_FIELD',
      'warning:UNSUPPORTED_FIELD',
      'info:PRIMARY_KEY_FROM_UNIQUE',
    ]);
  });

  it('escapes Python keywords and names the generated module uses', () => {
    const models = file(
      run(sqlalchemyAdapter, `${ds('sqlite')}model Item {\n  id Int @id\n  class String\n  metadata String\n  sa Int\n}\n`),
      'models.py',
    );
    expect(models).toContain('class_: Mapped[str] = mapped_column("class", sa.Text())');
    expect(models).toContain('metadata_: Mapped[str] = mapped_column("metadata", sa.Text())');
    expect(models).toContain('sa_: Mapped[int] = mapped_column("sa", sa.Integer())');
  });

  it('renders defaults and reports the ones it cannot express', () => {
    const output = run(
      sqlalchemyAdapter,
      `${ds('postgresql')}
model Item {
  id        String   @id @default(uuid())
  code      String   @default(cuid())
  active    Boolean  @default(true)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
`,
    );
    const models = file(output, 'models.py');
    expect(models).toContain('default=lambda: str(uuid.uuid4())');
    expect(models).toContain('server_default=sa.true()');
    expect(models).toContain('server_default=sa.func.now()');
    expect(models).toMatch(/updated_at: .*onupdate=sa\.func\.now\(\)/);
    expect(output.diagnostics).toEqual([expect.objectContaining({ code: 'DEFAULT_SKIPPED', model: 'Item', field: 'code' })]);
  });

  it('falls back to JSON for scalar lists outside PostgreSQL', () => {
    const source = `${ds('postgresql')}model T {\n  id Int @id\n  tags String[]\n}\n`;
    expect(file(run(sqlalchemyAdapter, source), 'models.py')).toContain('postgresql.ARRAY(sa.Text())');
    const mysql = run(sqlalchemyAdapter, source, { provider: 'mysql' });
    expect(codes(mysql.diagnostics)).toEqual(['warning:SCALAR_LIST']);
    expect(file(mysql, 'models.py')).toContain('tags: Mapped[list[str]] = mapped_column(sa.JSON())');
  });

  it('generates generic types without a provider and rejects MongoDB', () => {
    const generic = run(sqlalchemyAdapter, 'model A {\n  id Int @id\n}\n');
    expect(codes(generic.diagnostics)).toEqual(['info:GENERIC_DIALECT']);
    expect(file(generic, 'models.py')).toContain('id: Mapped[int] = mapped_column(sa.Integer(), primary_key=True)');
    const mongo = run(sqlalchemyAdapter, `${ds('mongodb')}model A {\n  id String @id @map("_id")\n}\n`);
    expect(mongo).toEqual({ files: [], diagnostics: [expect.objectContaining({ severity: 'error', code: 'UNSUPPORTED_PROVIDER' })] });
  });
});
