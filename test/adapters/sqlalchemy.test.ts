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

  it('keeps integer ids without @default(autoincrement()) from becoming SERIAL', () => {
    const models = file(
      run(sqlalchemyAdapter, `${ds('postgresql')}model A {\n  id Int @id\n}\nmodel B {\n  id BigInt @id @default(autoincrement())\n}\n`),
      'models.py',
    );
    expect(models).toContain('id: Mapped[int] = mapped_column(sa.Integer(), primary_key=True, autoincrement=False)');
    expect(models).toContain('id: Mapped[int] = mapped_column(sa.BigInteger(), primary_key=True, autoincrement=True)');
  });

  it('makes join table columns NOT NULL when they are not a primary key', () => {
    const models = file(run(sqlalchemyAdapter, fixture('many_to_many').source), 'models.py');
    expect(models).toContain('name="_CourseToStudent_A_fkey"), nullable=False),');
    expect(models).toContain('name="_CourseToStudent_B_fkey"), nullable=False),');
  });

  it('renders now() on MySQL as CURRENT_TIMESTAMP with the column precision', () => {
    const models = file(
      run(
        sqlalchemyAdapter,
        `${ds('mysql')}model T {\n  id Int @id\n  a DateTime @default(now())\n  b DateTime @default(now()) @db.Timestamp(6)\n  c DateTime @default(now()) @db.DateTime(0)\n}\n`,
      ),
      'models.py',
    );
    expect(models).toContain('a: Mapped[datetime.datetime] = mapped_column(mysql.DATETIME(fsp=3), server_default=sa.text("CURRENT_TIMESTAMP(3)"))');
    expect(models).toContain('b: Mapped[datetime.datetime] = mapped_column(mysql.TIMESTAMP(fsp=6), server_default=sa.text("CURRENT_TIMESTAMP(6)"))');
    expect(models).toContain('c: Mapped[datetime.datetime] = mapped_column(mysql.DATETIME(fsp=0), server_default=sa.text("CURRENT_TIMESTAMP(0)"))');
    expect(file(run(sqlalchemyAdapter, fixture('sqlite_app').source), 'models.py')).toContain('server_default=sa.func.now()');
  });

  it('emits @@ignore models as tables without a mapped class', () => {
    const output = run(sqlalchemyAdapter, fixture('ignored').source);
    const models = file(output, 'models.py');
    expect(models).toContain(
      [
        '# Raw audit rows without a key.',
        'audit_log_table = sa.Table(',
        '    "audit_log",',
        '    Base.metadata,',
        '    sa.Column("user_id", sa.Integer(), sa.ForeignKey("User.id", ondelete="RESTRICT", onupdate="CASCADE", name="audit_log_user_fk"), nullable=False),',
      ].join('\n'),
    );
    expect(models).toContain('    sa.Column("id", sa.Integer(), primary_key=True, autoincrement=False),\n    sa.Column("name", sa.Text(), nullable=False),');
    expect(models).not.toMatch(/class (AuditLog|Tag)\b/);
    // The join table of an ignored relation still exists in the database.
    expect(models).toContain('tag_to_user_table = sa.Table(');
    expect(codes(output.diagnostics)).toEqual(['info:IGNORED_MODEL', 'info:IGNORED_MODEL']);
  });

  it('keeps @ignore columns in the table but out of the mapping', () => {
    const models = file(run(sqlalchemyAdapter, fixture('ignored').source), 'models.py');
    expect(models).toContain('        # Kept in the database, hidden from Prisma Client.\n        sa.Column("legacy_code", sa.Text()),');
    expect(models).toContain('    __mapper_args__ = {"exclude_properties": ["legacy_code"]}');
    expect(models).not.toMatch(/legacy\w*: Mapped/);
    const keyless = file(
      run(sqlalchemyAdapter, `${ds('sqlite')}model A {\n  code String @unique\n  note String @ignore\n}\n`),
      'models.py',
    );
    expect(keyless).toContain('sa.Column("note", sa.Text(), nullable=False),');
    expect(keyless).toContain('__mapper_args__ = {"exclude_properties": ["note"], "primary_key": [code]}');
  });

  it('drops relationship() for @ignore relation fields but keeps their foreign keys', () => {
    const models = file(run(sqlalchemyAdapter, fixture('ignored').source), 'models.py');
    expect(models).not.toMatch(/\b(pinned|logs|tags): Mapped/);
    expect(models).toContain('sa.ForeignKey("Post.id", ondelete="SET NULL", onupdate="CASCADE", name="user_pinned_post_fk", use_alter=True)');
    // The other side is in Prisma Client, so it stays, without back_populates.
    expect(models).toContain('pinned_by: Mapped[Optional[User]] = relationship(foreign_keys="[User.pinned_id]")');
  });

  it('uses @relation(map: ...) names and use_alter only for foreign keys in a cycle', () => {
    const models = file(run(sqlalchemyAdapter, fixture('ignored').source), 'models.py');
    expect(models).toContain('sa.ForeignKey("User.id", ondelete="CASCADE", onupdate="CASCADE", name="post_author_fk", use_alter=True)');
    const acyclic = file(run(sqlalchemyAdapter, fixture('blog').source), 'models.py');
    expect(acyclic).not.toContain('use_alter');
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
    expect(file(generic, 'models.py')).toContain('id: Mapped[int] = mapped_column(sa.Integer(), primary_key=True, autoincrement=False)');
    const mongo = run(sqlalchemyAdapter, `${ds('mongodb')}model A {\n  id String @id @map("_id")\n}\n`);
    expect(mongo).toEqual({ files: [], diagnostics: [expect.objectContaining({ severity: 'error', code: 'UNSUPPORTED_PROVIDER' })] });
  });
});
