/**
 * Diesel adapter: emits `schema.rs` (`table!`, `joinable!`,
 * `allow_tables_to_appear_in_same_query!`, custom SQL types for enums) and
 * `models.rs` (structs, insert structs and enums) for Diesel 2.
 */
import { DiagnosticBag, type Adapter, type AdapterOptions, type AdapterOutput } from '../../core/adapter.js';
import type {
  IrColumnField,
  IrEnum,
  IrForeignKeyRelation,
  IrManyToManyRelation,
  IrModel,
  IrSchema,
} from '../../core/ir.js';
import { toPascalCase, toSnakeCase } from '../../core/names.js';
import { claim, docLines, generatedBy, identifier } from '../shared.js';
import { mapScalarType, requiredFeatures, type DieselBackend } from './types.js';

export type DieselOptions = AdapterOptions;

const BACKENDS: Readonly<Record<string, DieselBackend>> = {
  postgresql: 'pg',
  cockroachdb: 'pg',
  mysql: 'mysql',
  sqlite: 'sqlite',
};

const BACKEND: Readonly<Record<DieselBackend, { feature: string; type: string; value: string }>> = {
  pg: { feature: 'postgres', type: 'diesel::pg::Pg', value: "diesel::pg::PgValue<'_>" },
  mysql: { feature: 'mysql', type: 'diesel::mysql::Mysql', value: "diesel::mysql::MysqlValue<'_>" },
  sqlite: { feature: 'sqlite', type: 'diesel::sqlite::Sqlite', value: "diesel::sqlite::SqliteValue<'_, '_, '_>" },
};

// Strict, reserved and weak keywords that cannot be plain identifiers.
const RUST_KEYWORDS = new Set(
  (
    'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move ' +
    'mut pub ref return self Self static struct super trait true type unsafe use where while abstract become box do ' +
    'final macro override priv typeof unsized virtual yield try gen union'
  ).split(' '),
);
// Names `table!` defines inside each table module.
const TABLE_MODULE_ITEMS = ['table', 'columns', 'star', 'all_columns', 'dsl'];
// Types the generated code refers to unqualified.
const RESERVED_TYPES = ['Self', 'String', 'Option', 'Vec', 'Some', 'None', 'Ok', 'Err', 'Result', 'Box'];
// Table modules sit next to these crate and module names in schema.rs.
const RESERVED_TABLES = ['sql_types', 'diesel', 'std', 'core', 'alloc'];
// Enum SQL types are imported into `table!` next to `diesel::sql_types::*`.
const DIESEL_SQL_TYPES = new Set(
  (
    'Array Bigint BigInt Binary Blob Bool Bpchar Bytea Date Datetime Double Float Float4 Float8 Int2 Int4 Int8 ' +
    'Integer Json Jsonb Money Nullable Numeric Oid SmallInt Text Time Timestamp Timestamptz TinyInt Unsigned Uuid Varchar'
  ).split(' '),
);

interface Column {
  readonly ident: string;
  readonly sqlName: string;
  /** Full SQL type, including `Nullable<>` / `Array<>`. */
  readonly sqlType: string;
  /** Full Rust type, including `Option<>` / `Vec<>`. */
  readonly rustType: string;
  readonly field: IrColumnField | null;
  readonly isAutoincrement: boolean;
  readonly hasDatabaseDefault: boolean;
  /** `@ignore`: in `table!`, not in the structs. */
  readonly isIgnored: boolean;
}

interface BelongsTo {
  readonly parent: string;
  readonly foreignKey: string;
}

interface Table {
  readonly ident: string;
  readonly sqlName: string;
  readonly schema: string | null;
  readonly structName: string;
  readonly documentation: string | null;
  readonly columns: Column[];
  readonly primaryKey: string[];
  readonly belongsTo: BelongsTo[];
  /** Custom SQL types (enum structs in `sql_types`) used by the table. */
  readonly customTypes: Set<string>;
  readonly isJoinTable: boolean;
  /** No structs: the model has `@@ignore`, or the join table relates one. */
  readonly isIgnored: boolean;
}

interface EnumPlan {
  readonly source: IrEnum;
  readonly rustName: string;
  readonly variants: readonly { readonly ident: string; readonly dbValue: string }[];
}

function rustIdent(name: string, fallback: string): string {
  const ident = identifier(toSnakeCase(name), fallback);
  return RUST_KEYWORDS.has(ident) ? `${ident}_` : ident;
}

function rustTypeName(name: string, fallback: string): string {
  const ident = identifier(toPascalCase(name), fallback);
  return RUST_KEYWORDS.has(ident) ? `${ident}_` : ident;
}

function rustString(value: string): string {
  return `"${value.replace(/[\\"]/g, (c) => `\\${c}`).replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`;
}

function docComments(documentation: string | null, indent: string): string[] {
  return docLines(documentation).map((line) => `${indent}///${line === '' ? '' : ` ${line.trimEnd()}`}`);
}

class DieselGenerator {
  private readonly diagnostics = new DiagnosticBag();
  private readonly enums = new Map<string, EnumPlan>();
  private readonly tables = new Map<string, Table>();
  private readonly joinables: { child: string; parent: string; foreignKey: string }[] = [];
  private readonly joinedPairs = new Set<string>();
  private readonly tableIdents = new Set(RESERVED_TABLES);
  private readonly typeNames = new Set(RESERVED_TYPES);

  constructor(
    private readonly ir: IrSchema,
    private readonly backend: DieselBackend,
  ) {}

  run(): AdapterOutput {
    for (const e of this.ir.enums) this.planEnum(e);
    for (const model of this.ir.models) this.planModel(model);
    for (const relation of this.ir.relations) {
      if (relation.kind === 'many-to-many') this.planJoinTable(relation);
      else this.planForeignKey(relation);
    }
    if (this.backend === 'sqlite' && this.usesDateTime()) {
      this.diagnostics.info(
        'SQLITE_DATETIME',
        'Prisma stores DateTime on SQLite as Unix milliseconds by default; Diesel reads Timestamp as text, so values written by Prisma may not parse',
      );
    }
    return {
      files: [
        { path: 'schema.rs', contents: this.renderSchema() },
        { path: 'models.rs', contents: this.renderModels() },
      ],
      diagnostics: this.diagnostics.items,
    };
  }

  private usesDateTime(): boolean {
    return [...this.tables.values()].some((t) => t.columns.some((c) => c.field?.kind === 'scalar' && c.field.type === 'DateTime'));
  }

  // ---- planning ----

  private planEnum(e: IrEnum): void {
    const taken = new Set<string>();
    this.enums.set(e.name, {
      source: e,
      rustName: claim(this.enumTypeName(e.name), this.typeNames),
      variants: e.values.map((v, i) => ({ ident: claim(rustTypeName(v.name, `Variant${i}`), taken), dbValue: v.dbName })),
    });
  }

  private enumTypeName(name: string): string {
    const base = rustTypeName(name, 'Enum');
    return DIESEL_SQL_TYPES.has(base) ? `${base}_` : base;
  }

  private columnType(field: IrColumnField, model: IrModel, table: { customTypes: Set<string> }): { sql: string; rust: string } | null {
    let sql: string;
    let rust: string;
    if (field.kind === 'enum') {
      const plan = this.enums.get(field.type);
      if (plan === undefined) return null;
      rust = plan.rustName;
      if (this.backend === 'sqlite') {
        sql = 'Text';
      } else {
        sql = plan.rustName;
        table.customTypes.add(plan.rustName);
      }
    } else {
      const mapping = mapScalarType(this.backend, field.type, field.nativeType);
      if (!mapping.ok) {
        this.diagnostics.warning('UNSUPPORTED_TYPE', `${mapping.reason}; column "${field.dbName}" is omitted`, {
          model: model.name,
          field: field.name,
        });
        return null;
      }
      if (mapping.note !== undefined) {
        this.diagnostics.add(mapping.note.severity, 'TYPE_APPROXIMATED', mapping.note.message, { model: model.name, field: field.name });
      }
      ({ sql, rust } = mapping.type);
    }
    if (field.isList) {
      sql = `Array<${sql}>`;
      rust = `Vec<${rust}>`;
    }
    if (!field.isRequired) {
      sql = `Nullable<${sql}>`;
      rust = `Option<${rust}>`;
    }
    return { sql, rust };
  }

  private planModel(model: IrModel): void {
    const ident = claim(rustIdent(model.name, 'table'), this.tableIdents);
    const table: Table = {
      ident,
      sqlName: model.dbName,
      schema: model.schema,
      structName: claim(rustTypeName(model.name, 'Model'), this.typeNames),
      documentation: model.documentation,
      columns: [],
      primaryKey: [],
      belongsTo: [],
      customTypes: new Set(),
      isJoinTable: false,
      isIgnored: model.isIgnored,
    };
    // A column may not share its table's name, nor the items `table!` generates.
    const columnIdents = new Set([ident, ...TABLE_MODULE_ITEMS]);
    for (const field of model.fields) {
      if (field.kind === 'relation') continue;
      if (field.kind === 'unsupported') {
        this.diagnostics.warning(
          'UNSUPPORTED_FIELD',
          `Unsupported("${field.type}") has no Diesel type; column "${field.dbName}" is omitted`,
          { model: model.name, field: field.name },
        );
        continue;
      }
      const type = this.columnType(field, model, table);
      if (type === null) continue;
      table.columns.push({
        ident: claim(rustIdent(field.name, 'column'), columnIdents),
        sqlName: field.dbName,
        sqlType: type.sql,
        rustType: type.rust,
        field,
        isAutoincrement: field.default?.kind === 'function' && field.default.name === 'autoincrement',
        hasDatabaseDefault: field.default?.generatedBy === 'database',
        isIgnored: field.isIgnored,
      });
    }

    const key = this.primaryKeyOf(model, table);
    if (key === null) return;
    if (model.isIgnored) {
      this.diagnostics.info('IGNORED_MODEL', '@@ignore: the table is in schema.rs, but models.rs has no struct for it', { model: model.name });
    }
    table.primaryKey.push(...key);
    if (table.columns.length > 32) {
      const feature = table.columns.length > 64 ? '128-column-tables' : '64-column-tables';
      this.diagnostics.warning('TOO_MANY_COLUMNS', `${table.columns.length} columns need Diesel's "${feature}" feature`, {
        model: model.name,
      });
    }
    this.tables.set(model.name, table);
  }

  private columnIdentsOf(table: Table, fields: readonly string[]): string[] | null {
    const idents = fields.map((name) => table.columns.find((c) => c.field?.name === name)?.ident);
    return idents.every((i): i is string => i !== undefined) ? idents : null;
  }

  private primaryKeyOf(model: IrModel, table: Table): string[] | null {
    if (model.primaryKey !== null) {
      const key = this.columnIdentsOf(table, model.primaryKey.fields);
      if (key === null) {
        this.diagnostics.error('KEY_COLUMN_OMITTED', 'A primary key column has no Diesel type; the model is skipped', {
          model: model.name,
        });
      }
      return key;
    }
    for (const unique of model.uniques) {
      const key = this.columnIdentsOf(table, unique.fields);
      if (key !== null) {
        this.diagnostics.info(
          'PRIMARY_KEY_FROM_UNIQUE',
          `No @id; the unique constraint on (${unique.fields.join(', ')}) is used as the Diesel primary key`,
          { model: model.name },
        );
        return key;
      }
    }
    if (model.isIgnored) {
      this.diagnostics.warning('IGNORED_MODEL_SKIPPED', '@@ignore model without a usable @id or @unique; table! needs a primary key, so it is skipped', {
        model: model.name,
      });
    } else {
      this.diagnostics.error('NO_PRIMARY_KEY', 'No usable @id or @unique for a Diesel primary key; the model is skipped', {
        model: model.name,
      });
    }
    return null;
  }

  /** Adds `joinable!` unless the pair already has one (Diesel allows one per pair, in either direction). */
  private addJoinable(child: Table, parent: Table, foreignKey: string, relation: string, model: string): void {
    if (child === parent) {
      this.diagnostics.info('JOINABLE_SKIPPED', `Self-relation "${relation}": no joinable!; use diesel::alias! to join`, { model });
      return;
    }
    const pair = [child.ident, parent.ident].sort().join(' ');
    if (this.joinedPairs.has(pair)) {
      this.diagnostics.warning(
        'JOINABLE_SKIPPED',
        `Relation "${relation}": ${child.ident} and ${parent.ident} already have a joinable!; Diesel allows only one per table pair`,
        { model },
      );
      return;
    }
    this.joinedPairs.add(pair);
    this.joinables.push({ child: child.ident, parent: parent.ident, foreignKey });
  }

  /**
   * Adds `belongs_to` unless the child already belongs to that parent type (impls would conflict).
   * Needs both structs, so not when a side is ignored.
   */
  private addBelongsTo(child: Table, parent: Table, foreignKey: string, relation: string, model: string): void {
    if (child.isIgnored || parent.isIgnored) return;
    if (child.belongsTo.some((b) => b.parent === parent.structName)) {
      this.diagnostics.warning(
        'BELONGS_TO_SKIPPED',
        `Relation "${relation}": ${child.structName} already has belongs_to(${parent.structName}); Diesel allows only one per parent type`,
        { model },
      );
      return;
    }
    child.belongsTo.push({ parent: parent.structName, foreignKey });
  }

  private planForeignKey(relation: IrForeignKeyRelation): void {
    const child = this.tables.get(relation.from.model);
    const parent = this.tables.get(relation.to.model);
    if (child === undefined || parent === undefined) return;
    const at = { model: relation.from.model, field: relation.from.field };
    if (relation.fields.length !== 1 || !relation.referencesPrimaryKey) {
      this.diagnostics.warning(
        'RELATION_HELPERS_SKIPPED',
        `Relation "${relation.name}": ${relation.fields.length === 1 ? 'the foreign key does not reference the primary key' : 'composite foreign key'}; no joinable!/belongs_to generated`,
        at,
      );
      return;
    }
    const foreignKey = this.columnIdentsOf(child, relation.fields)?.[0];
    if (foreignKey === undefined) return;
    this.addJoinable(child, parent, foreignKey, relation.name, at.model);
    this.addBelongsTo(child, parent, foreignKey, relation.name, at.model);
  }

  private planJoinTable(relation: IrManyToManyRelation): void {
    const sides = relation.joinTable.columns.map((column) => {
      const parent = this.tables.get(column.model);
      const key = parent?.columns.find((c) => c.field?.name === column.references);
      return parent === undefined || key === undefined ? undefined : { column, parent, key };
    });
    const [a, b] = sides;
    if (a === undefined || b === undefined) {
      this.diagnostics.warning('JOIN_TABLE_SKIPPED', `Join table ${relation.joinTable.dbName} refers to a skipped model or key`, {
        model: relation.a.model,
      });
      return;
    }
    const ident = claim(rustIdent(relation.name, 'join_table'), this.tableIdents);
    const table: Table = {
      ident,
      sqlName: relation.joinTable.dbName,
      schema: relation.joinTable.schema,
      structName: claim(rustTypeName(relation.name, 'JoinTable'), this.typeNames),
      documentation: `Join table of the implicit many-to-many relation "${relation.name}".`,
      columns: [a, b].map(({ column, key }) => ({
        ident: column.name.toLowerCase(),
        sqlName: column.name,
        sqlType: key.sqlType,
        rustType: key.rustType,
        field: null,
        isAutoincrement: false,
        hasDatabaseDefault: false,
        isIgnored: false,
      })),
      primaryKey: ['a', 'b'],
      belongsTo: [],
      // An enum primary key makes the join column use the enum's SQL type.
      customTypes: new Set([a, b].map((s) => s.key.sqlType).filter((t) => a.parent.customTypes.has(t) || b.parent.customTypes.has(t))),
      isJoinTable: true,
      isIgnored: a.parent.isIgnored || b.parent.isIgnored,
    };
    this.tables.set(`\u0000${relation.name}`, table);
    for (const side of [a, b]) {
      const fk = side.column.name.toLowerCase();
      this.addJoinable(table, side.parent, fk, relation.name, side.column.model);
      this.addBelongsTo(table, side.parent, fk, relation.name, side.column.model);
    }
  }

  // ---- rendering ----

  private renderSchema(): string {
    const out: string[] = [`// ${generatedBy('diesel')}`, ''];
    const enumsInUse = [...this.enums.values()].filter((e) => [...this.tables.values()].some((t) => t.customTypes.has(e.rustName)));
    if (enumsInUse.length > 0) {
      out.push('pub mod sql_types {');
      enumsInUse.forEach((e, i) => {
        if (i > 0) out.push('');
        out.push('    #[derive(diesel::query_builder::QueryId, Clone, Debug, diesel::sql_types::SqlType)]');
        out.push(
          this.backend === 'pg'
            ? `    #[diesel(postgres_type(name = ${rustString(e.source.dbName)}))]`
            : '    #[diesel(mysql_type(name = "Enum"))]',
        );
        out.push(`    pub struct ${e.rustName};`);
      });
      out.push('}', '');
    }

    for (const table of this.tables.values()) {
      out.push('diesel::table! {');
      if (table.customTypes.size > 0) {
        out.push('    use diesel::sql_types::*;');
        for (const type of [...table.customTypes].sort()) out.push(`    use super::sql_types::${type};`);
        out.push('');
      }
      out.push(...docComments(table.documentation, '    '));
      if (table.sqlName !== table.ident) out.push(`    #[sql_name = ${rustString(table.sqlName)}]`);
      const schema = table.schema !== null && /^[A-Za-z_][A-Za-z0-9_]*$/.test(table.schema) ? `${table.schema}.` : '';
      out.push(`    ${schema}${table.ident} (${table.primaryKey.join(', ')}) {`);
      for (const column of table.columns) {
        out.push(...docComments(column.field?.documentation ?? null, '        '));
        if (column.sqlName !== column.ident) out.push(`        #[sql_name = ${rustString(column.sqlName)}]`);
        out.push(`        ${column.ident} -> ${column.sqlType},`);
      }
      out.push('    }', '}', '');
    }

    for (const j of this.joinables) out.push(`diesel::joinable!(${j.child} -> ${j.parent} (${j.foreignKey}));`);
    if (this.joinables.length > 0) out.push('');

    const idents = [...this.tables.values()].map((t) => t.ident);
    if (idents.length > 1) {
      out.push('diesel::allow_tables_to_appear_in_same_query!(', ...idents.map((i) => `    ${i},`), ');', '');
    }
    return `${out.join('\n').trimEnd()}\n`;
  }

  private renderModels(): string {
    const backend = BACKEND[this.backend];
    const tables = [...this.tables.values()];
    const { features, crates } = requiredFeatures(tables.flatMap((t) => t.columns.map((c) => c.rustType)));
    const out: string[] = [
      `// ${generatedBy('diesel')}`,
      '//',
      `// Requires diesel features: ${[backend.feature, ...features].join(', ')}`,
      ...(crates.length > 0 ? [`// and the crates: ${crates.join(', ')}`] : []),
      '',
      'use diesel::prelude::*;',
      '',
    ];
    for (const e of this.enums.values()) out.push(...this.renderEnum(e), '');
    for (const table of tables) {
      if (table.isIgnored) continue;
      out.push(...this.renderStruct(table), '');
      if (!table.isJoinTable) out.push(...this.renderInsertStruct(table));
    }
    return `${out.join('\n').trimEnd()}\n`;
  }

  private renderStruct(table: Table): string[] {
    const derives = ['Queryable', 'Selectable', 'Identifiable', ...(table.belongsTo.length > 0 ? ['Associations'] : []), 'Insertable'];
    const ignored = table.columns.filter((c) => c.isIgnored).map((c) => `\`${c.ident}\``);
    const note = ignored.length === 0 ? [] : [`Leaves out \`@ignore\` columns (${ignored.join(', ')}); select with \`${table.structName}::as_select()\`.`];
    const out = [
      ...docComments([table.documentation, ...note].filter((d) => d !== null).join('\n\n') || null, ''),
      `#[derive(${derives.join(', ')}, Debug, Clone, PartialEq)]`,
      `#[diesel(table_name = super::schema::${table.ident})]`,
    ];
    if (table.primaryKey.length !== 1 || table.primaryKey[0] !== 'id') {
      out.push(`#[diesel(primary_key(${table.primaryKey.join(', ')}))]`);
    }
    for (const b of table.belongsTo) out.push(`#[diesel(belongs_to(${b.parent}, foreign_key = ${b.foreignKey}))]`);
    out.push(`#[diesel(check_for_backend(${BACKEND[this.backend].type}))]`, `pub struct ${table.structName} {`);
    for (const column of table.columns) {
      if (column.isIgnored) continue;
      out.push(...docComments(column.field?.documentation ?? null, '    '), `    pub ${column.ident}: ${column.rustType},`);
    }
    out.push('}');
    return out;
  }

  /**
   * `New<Model>` for inserts that let the database fill defaults: autoincrement
   * columns are left out and columns with a database default become optional
   * (`None` inserts `DEFAULT`). Only emitted when such columns exist.
   */
  private renderInsertStruct(table: Table): string[] {
    if (!table.columns.some((c) => c.hasDatabaseDefault && !c.isIgnored)) return [];
    const columns = table.columns.filter((c) => !c.isAutoincrement && !c.isIgnored);
    if (columns.length === 0) return [];
    const name = claim(`New${table.structName}`, this.typeNames);
    const out = [
      `/// Insertable form of [\`${table.structName}\`] that leaves database defaults to the database.`,
      '#[derive(Insertable, Debug, Clone, PartialEq)]',
      `#[diesel(table_name = super::schema::${table.ident})]`,
      `pub struct ${name} {`,
    ];
    for (const column of columns) {
      const optional = column.hasDatabaseDefault && !column.rustType.startsWith('Option<');
      out.push(`    pub ${column.ident}: ${optional ? `Option<${column.rustType}>` : column.rustType},`);
    }
    out.push('}', '');
    return out;
  }

  private renderEnum(e: EnumPlan): string[] {
    const backend = BACKEND[this.backend];
    const sqlType = this.backend === 'sqlite' ? 'diesel::sql_types::Text' : `super::schema::sql_types::${e.rustName}`;
    const name = e.rustName;
    const out = [
      ...docComments(e.source.documentation, ''),
      '#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, diesel::expression::AsExpression, diesel::deserialize::FromSqlRow)]',
      `#[diesel(sql_type = ${sqlType})]`,
      `pub enum ${name} {`,
      ...e.variants.map((v) => `    ${v.ident},`),
      '}',
      '',
      `impl ${name} {`,
      '    /// The value stored in the database.',
      "    pub fn db_value(self) -> &'static str {",
      '        match self {',
      ...e.variants.map((v) => `            Self::${v.ident} => ${rustString(v.dbValue)},`),
      '        }',
      '    }',
      '',
      '    /// Parses a value stored in the database.',
      '    pub fn from_db_value(value: &str) -> Option<Self> {',
      '        match value {',
      ...e.variants.map((v) => `            ${rustString(v.dbValue)} => Some(Self::${v.ident}),`),
      '            _ => None,',
      '        }',
      '    }',
      '}',
      '',
      `impl diesel::serialize::ToSql<${sqlType}, ${backend.type}> for ${name} {`,
      `    fn to_sql<'b>(&'b self, out: &mut diesel::serialize::Output<'b, '_, ${backend.type}>) -> diesel::serialize::Result {`,
      ...(this.backend === 'sqlite'
        ? ['        out.set_value(self.db_value());']
        : ['        std::io::Write::write_all(out, self.db_value().as_bytes())?;']),
      '        Ok(diesel::serialize::IsNull::No)',
      '    }',
      '}',
      '',
      `impl diesel::deserialize::FromSql<${sqlType}, ${backend.type}> for ${name} {`,
      `    fn from_sql(value: ${backend.value}) -> diesel::deserialize::Result<Self> {`,
      ...(this.backend === 'sqlite'
        ? [`        let text = <String as diesel::deserialize::FromSql<${sqlType}, ${backend.type}>>::from_sql(value)?;`]
        : ['        let text = std::str::from_utf8(value.as_bytes())?;']),
      `        Self::from_db_value(${this.backend === 'sqlite' ? '&text' : 'text'}).ok_or_else(|| format!("unrecognized ${name} value: {text}").into())`,
      '    }',
      '}',
    ];
    return out;
  }
}

function generate(ir: IrSchema, options?: DieselOptions): AdapterOutput {
  const provider = options?.provider ?? ir.provider;
  const backend = provider !== null && Object.hasOwn(BACKENDS, provider) ? BACKENDS[provider] : undefined;
  if (backend === undefined) {
    const diagnostics = new DiagnosticBag();
    if (provider === null) {
      diagnostics.error('MISSING_PROVIDER', 'The schema has no datasource; pass a provider (postgresql, mysql or sqlite)');
    } else {
      diagnostics.error('UNSUPPORTED_PROVIDER', `Diesel supports postgresql, mysql and sqlite, not "${provider}"`);
    }
    return { files: [], diagnostics: diagnostics.items };
  }
  const output = new DieselGenerator(ir, backend).run();
  if (provider === 'cockroachdb') {
    return {
      files: output.files,
      diagnostics: [
        { severity: 'info', code: 'COCKROACHDB_AS_POSTGRES', message: 'CockroachDB is generated with the Diesel PostgreSQL backend' },
        ...output.diagnostics,
      ],
    };
  }
  return output;
}

export const dieselAdapter: Adapter<DieselOptions> = { name: 'diesel', generate };
