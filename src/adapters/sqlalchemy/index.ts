/**
 * SQLAlchemy adapter: emits `models.py` with SQLAlchemy 2.0 declarative
 * classes (`Mapped` / `mapped_column`), `relationship()`s, Python enums and
 * association tables for implicit many-to-many relations. `@@ignore` models
 * become plain `sa.Table`s and `@ignore` columns stay in the table but out of
 * the mapping, so `Base.metadata` still describes the whole database.
 */
import { DiagnosticBag, findRelation, type Adapter, type AdapterOptions, type AdapterOutput } from '../../core/adapter.js';
import type {
  IrColumnField,
  IrEnum,
  IrForeignKeyRelation,
  IrManyToManyRelation,
  IrModel,
  IrRelation,
  IrRelationField,
  IrSchema,
  ReferentialAction,
} from '../../core/ir.js';
import { toPascalCase, toSnakeCase } from '../../core/names.js';
import { claim, columnFields, docLines, generatedBy, identifier } from '../shared.js';
import { mapScalarType, type Dialect } from './types.js';

export type SqlAlchemyOptions = AdapterOptions;

const DIALECTS: Readonly<Record<string, Dialect>> = {
  postgresql: 'postgresql',
  cockroachdb: 'postgresql',
  mysql: 'mysql',
  sqlite: 'sqlite',
  sqlserver: 'generic',
};

const PY_KEYWORDS = new Set(
  (
    'False None True and as assert async await break class continue def del elif else except finally for from ' +
    'global if import in is lambda nonlocal not or pass raise return try while with yield'
  ).split(' '),
);
// Names the class body and module refer to; an attribute with one of these names would shadow it.
const RESERVED_ATTRIBUTES = [
  'sa',
  'mysql',
  'postgresql',
  'mapped_column',
  'relationship',
  'Mapped',
  'Optional',
  'Any',
  'uuid',
  'datetime',
  'decimal',
  'enum',
  'metadata',
  'registry',
];
const RESERVED_CLASSES = ['Base', 'Mapped', 'Optional', 'Any', 'DeclarativeBase'];

const ACTIONS: Readonly<Record<ReferentialAction, string>> = {
  Cascade: 'CASCADE',
  Restrict: 'RESTRICT',
  NoAction: 'NO ACTION',
  SetNull: 'SET NULL',
  SetDefault: 'SET DEFAULT',
};

interface ColumnPlan {
  readonly field: IrColumnField;
  readonly attr: string;
  readonly sa: string;
  readonly py: string;
}

interface ModelPlan {
  readonly model: IrModel;
  /** Mapped class; empty for an ignored model. */
  readonly className: string;
  /** Module variable of the `sa.Table` of an ignored model, or null. */
  readonly tableVar: string | null;
  /** Python attribute per field name (columns and relations). */
  readonly attrs: Map<string, string>;
  readonly columns: Map<string, ColumnPlan>;
}

function pyString(value: string): string {
  return JSON.stringify(value);
}

function pyIdent(name: string, fallback: string): string {
  const ident = identifier(toSnakeCase(name), fallback);
  return PY_KEYWORDS.has(ident) ? `${ident}_` : ident;
}

function pyClassName(name: string, fallback: string): string {
  const ident = identifier(toPascalCase(name), fallback);
  return PY_KEYWORDS.has(ident) ? `${ident}_` : ident;
}

function enumMember(name: string): string {
  const ident = identifier(name, 'VALUE');
  return PY_KEYWORDS.has(ident) ? `${ident}_` : ident;
}

function comment(documentation: string | null, indent: string): string[] {
  return docLines(documentation).map((line) => `${indent}#${line === '' ? '' : ` ${line.trimEnd()}`}`);
}

function docstring(documentation: string | null, indent: string): string[] {
  if (documentation === null) return [];
  const text = documentation.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');
  const lines = text.split('\n');
  if (lines.length === 1) return [`${indent}"""${text.trim()}"""`, ''];
  return [`${indent}"""${lines[0]?.trim() ?? ''}`, ...lines.slice(1).map((l) => `${indent}${l.trimEnd()}`), `${indent}"""`, ''];
}

function tableRef(model: IrModel): string {
  return model.schema === null ? model.dbName : `${model.schema}.${model.dbName}`;
}

/**
 * Foreign keys between tables that reference each other in a cycle. SQLAlchemy
 * cannot order their CREATE TABLEs, so they get `use_alter=True` and are added
 * with ALTER TABLE afterwards, as Prisma Migrate does with every foreign key.
 */
function cyclicForeignKeys(relations: readonly IrRelation[]): Set<IrForeignKeyRelation> {
  const edges = relations.filter((r): r is IrForeignKeyRelation => r.kind !== 'many-to-many' && !r.isSelfRelation);
  const next = new Map<string, string[]>();
  for (const r of edges) next.set(r.from.model, [...(next.get(r.from.model) ?? []), r.to.model]);
  const reaches = (from: string, to: string): boolean => {
    const seen = new Set<string>();
    const stack = [from];
    for (let model = stack.pop(); model !== undefined; model = stack.pop()) {
      if (model === to) return true;
      if (seen.has(model)) continue;
      seen.add(model);
      stack.push(...(next.get(model) ?? []));
    }
    return false;
  };
  return new Set(edges.filter((r) => reaches(r.to.model, r.from.model)));
}

function actions(onDelete: ReferentialAction, onUpdate: ReferentialAction): string[] {
  return [
    ...(onDelete === 'NoAction' ? [] : [`ondelete=${pyString(ACTIONS[onDelete])}`]),
    ...(onUpdate === 'NoAction' ? [] : [`onupdate=${pyString(ACTIONS[onUpdate])}`]),
  ];
}

class SqlAlchemyGenerator {
  private readonly diagnostics = new DiagnosticBag();
  private readonly imports = new Set<string>();
  private readonly classNames = new Set(RESERVED_CLASSES);
  private readonly enumNames = new Map<string, string>();
  private readonly models = new Map<string, ModelPlan>();
  private readonly tableVars = new Map<string, string>();
  private readonly moduleNames = new Set(['Base', '_enum_values']);
  private readonly cyclic: ReadonlySet<IrForeignKeyRelation>;

  constructor(
    private readonly ir: IrSchema,
    private readonly dialect: Dialect,
  ) {
    this.cyclic = cyclicForeignKeys(ir.relations);
  }

  run(): AdapterOutput {
    for (const e of this.ir.enums) this.enumNames.set(e.name, claim(pyClassName(e.name, 'Enum'), this.classNames));
    for (const model of this.ir.models) this.planModel(model);

    const body: string[] = [];
    for (const e of this.ir.enums) body.push(...this.renderEnum(e), '', '');
    if (this.ir.enums.length > 0) body.push(...this.renderEnumHelper(), '', '');
    for (const relation of this.ir.relations) {
      if (relation.kind === 'many-to-many') {
        const table = this.renderAssociationTable(relation);
        if (table.length > 0) body.push(...table, '', '');
      }
    }
    for (const plan of this.models.values()) body.push(...this.renderModel(plan), '', '');

    if (body.some((line) => /\brelationship\(/.test(line))) this.imports.add('relationship');
    const contents = [...this.renderHeader(), '', 'class Base(DeclarativeBase):', '    pass', '', '', ...body];
    return {
      files: [{ path: 'models.py', contents: `${contents.join('\n').trimEnd()}\n` }],
      diagnostics: this.diagnostics.items,
    };
  }

  // ---- planning ----

  private planModel(model: IrModel): void {
    const attrs = new Map<string, string>();
    const taken = new Set(RESERVED_ATTRIBUTES);
    for (const field of model.fields) attrs.set(field.name, claim(pyIdent(field.name, 'field'), taken));
    const plan: ModelPlan = {
      model,
      className: model.isIgnored ? '' : claim(pyClassName(model.name, 'Model'), this.classNames),
      tableVar: model.isIgnored ? claim(`${pyIdent(model.name, 'model')}_table`, this.moduleNames) : null,
      attrs,
      columns: new Map(),
    };
    if (plan.tableVar !== null) {
      this.diagnostics.info('IGNORED_MODEL', `@@ignore: emitted as the table ${plan.tableVar} without a mapped class`, { model: model.name });
    }
    for (const field of columnFields(model)) {
      const type = this.columnType(field, model);
      plan.columns.set(field.name, { field, attr: attrs.get(field.name) ?? field.name, ...type });
    }
    for (const field of model.fields) {
      if (field.kind === 'unsupported') {
        this.diagnostics.warning(
          'UNSUPPORTED_FIELD',
          `Unsupported("${field.type}") has no SQLAlchemy type; column "${field.dbName}" is omitted`,
          { model: model.name, field: field.name },
        );
      }
    }
    this.models.set(model.name, plan);
  }

  private columnType(field: IrColumnField, model: IrModel): { sa: string; py: string } {
    let sa: string;
    let py: string;
    if (field.kind === 'enum') {
      py = this.enumNames.get(field.type) ?? 'str';
      const dbName = this.ir.enums.find((e) => e.name === field.type)?.dbName ?? field.type;
      sa = `sa.Enum(${py}, name=${pyString(dbName)}, values_callable=_enum_values)`;
    } else {
      const mapping = mapScalarType(this.dialect, field.type, field.nativeType);
      if (mapping.fallbackReason !== undefined) {
        this.diagnostics.warning('NATIVE_TYPE_FALLBACK', `${mapping.fallbackReason}; using ${mapping.type.sa}`, {
          model: model.name,
          field: field.name,
        });
      }
      ({ sa, py } = mapping.type);
    }
    if (field.isList) {
      if (this.dialect === 'postgresql') {
        sa = `postgresql.ARRAY(${sa})`;
      } else {
        this.diagnostics.warning('SCALAR_LIST', 'Scalar lists are only mapped on PostgreSQL; using sa.JSON()', {
          model: model.name,
          field: field.name,
        });
        sa = 'sa.JSON()';
      }
      py = `list[${py}]`;
    }
    return { sa, py: field.isRequired ? py : `Optional[${py}]` };
  }

  // ---- rendering ----

  private renderHeader(): string[] {
    const body = this.collectImports();
    return [
      `# ${generatedBy('sqlalchemy')}`,
      '"""SQLAlchemy 2.0 models generated from a Prisma schema."""',
      '',
      'from __future__ import annotations',
      '',
      ...body,
    ];
  }

  private collectImports(): string[] {
    const std = ['datetime', 'decimal', 'enum', 'uuid'].filter((m) => this.imports.has(m)).map((m) => `import ${m}`);
    const typing = ['Any', 'Optional'].filter((m) => this.imports.has(m));
    const dialects = ['mysql', 'postgresql'].filter((m) => this.imports.has(m));
    const orm = ['DeclarativeBase', 'Mapped', 'mapped_column', ...(this.imports.has('relationship') ? ['relationship'] : [])];
    return [
      ...std,
      ...(typing.length > 0 ? [`from typing import ${typing.join(', ')}`] : []),
      ...(std.length > 0 || typing.length > 0 ? [''] : []),
      'import sqlalchemy as sa',
      ...(dialects.length > 0 ? [`from sqlalchemy.dialects import ${dialects.join(', ')}`] : []),
      `from sqlalchemy.orm import ${orm.join(', ')}`,
      '',
    ];
  }

  /** Records the imports an emitted expression needs. */
  private use(...expressions: string[]): void {
    for (const text of expressions) {
      for (const name of ['datetime', 'decimal', 'enum', 'uuid', 'mysql', 'postgresql']) {
        if (new RegExp(`\\b${name}\\.`).test(text)) this.imports.add(name);
      }
      for (const name of ['Any', 'Optional']) if (new RegExp(`\\b${name}\\b`).test(text)) this.imports.add(name);
    }
  }

  private renderEnum(e: IrEnum): string[] {
    this.use('enum.');
    const name = this.enumNames.get(e.name) ?? e.name;
    const taken = new Set<string>();
    return [
      `class ${name}(str, enum.Enum):`,
      ...docstring(e.documentation, '    '),
      ...e.values.map((v) => `    ${claim(enumMember(v.name), taken)} = ${pyString(v.dbName)}`),
    ];
  }

  private renderEnumHelper(): string[] {
    return [
      'def _enum_values(enum_class: type[enum.Enum]) -> list[str]:',
      '    """Stores enum values (Prisma `@map` names), not Python member names."""',
      '    return [member.value for member in enum_class]',
    ];
  }

  private renderAssociationTable(relation: IrManyToManyRelation): string[] {
    const { joinTable } = relation;
    const sides = joinTable.columns.map((column) => {
      const plan = this.models.get(column.model);
      return plan === undefined ? undefined : { column, plan, key: plan.columns.get(column.references) };
    });
    const [a, b] = sides;
    if (a?.key === undefined || b?.key === undefined) {
      this.diagnostics.warning('ASSOCIATION_TABLE_SKIPPED', `Join table ${joinTable.dbName} refers to an unknown model or key`, {
        model: relation.a.model,
      });
      return [];
    }
    const variable = claim(`${pyIdent(relation.name, 'association')}_table`, this.moduleNames);
    this.tableVars.set(relation.name, variable);
    const isPrimaryKey = joinTable.uniqueness.kind === 'primaryKey';
    const lines = [`${variable} = sa.Table(`, `    ${pyString(joinTable.dbName)},`, '    Base.metadata,'];
    [a, b].forEach((side, i) => {
      const target = `${tableRef(side.plan.model)}.${side.key?.field.dbName ?? ''}`;
      const fk = [pyString(target), ...actions('Cascade', 'Cascade'), `name=${pyString(joinTable.foreignKeyDbNames[i] ?? '')}`];
      lines.push(
        `    sa.Column(${pyString(side.column.name)}, sa.ForeignKey(${fk.join(', ')}), ${isPrimaryKey ? 'primary_key=True' : 'nullable=False'}),`,
      );
    });
    if (!isPrimaryKey) lines.push(`    sa.UniqueConstraint("A", "B", name=${pyString(joinTable.uniqueness.dbName)}),`);
    lines.push(`    sa.Index(${pyString(joinTable.indexDbName)}, "B"),`);
    if (joinTable.schema !== null) lines.push(`    schema=${pyString(joinTable.schema)},`);
    lines.push(')');
    return lines;
  }

  private renderModel(plan: ModelPlan): string[] {
    if (plan.tableVar !== null) return this.renderTable(plan, plan.tableVar);
    const { model } = plan;
    const out = [`class ${plan.className}(Base):`, ...docstring(model.documentation, '    '), `    __tablename__ = ${pyString(model.dbName)}`];
    out.push(...this.renderTableArgs(plan), '');

    for (const field of model.fields) {
      // `@ignore` columns are in `__table_args__`; `@ignore` relations get no relationship(), but keep their foreign key.
      if (field.kind === 'unsupported' || field.isIgnored) continue;
      out.push(...comment(field.documentation, '    '));
      if (field.kind === 'relation') {
        out.push(...this.renderRelationship(plan, field));
      } else {
        const column = plan.columns.get(field.name);
        if (column !== undefined) out.push(this.renderColumn(plan, column));
      }
    }

    out.push(...this.renderMapperArgs(plan));
    return out;
  }

  /** An ignored model: a table in `Base.metadata`, no mapped class. */
  private renderTable(plan: ModelPlan, variable: string): string[] {
    const { model } = plan;
    const out = [...comment(model.documentation, ''), `${variable} = sa.Table(`, `    ${pyString(model.dbName)},`, '    Base.metadata,'];
    for (const field of model.fields) {
      const column = plan.columns.get(field.name);
      if (column === undefined) continue;
      out.push(...comment(field.documentation, '    '), `    ${this.renderCoreColumn(plan, column)},`);
    }
    out.push(...this.tableConstraints(plan).map((c) => `    ${c},`));
    if (model.schema !== null) out.push(`    schema=${pyString(model.schema)},`);
    out.push(')');
    return out;
  }

  /** A column outside the mapping: of an ignored model, or an `@ignore` field. */
  private renderCoreColumn(plan: ModelPlan, column: ColumnPlan): string {
    const options = this.columnOptions(plan, column);
    const isPrimaryKey = plan.model.primaryKey?.fields.includes(column.field.name) ?? false;
    if (column.field.isRequired && !isPrimaryKey) options.push('nullable=False');
    this.use(...options);
    return `sa.Column(${[pyString(column.field.dbName), ...options].join(', ')})`;
  }

  /** Columns of `fields`, or undefined when one of them is not mapped. */
  private dbColumns(plan: ModelPlan, fields: readonly string[]): string[] | undefined {
    const columns = fields.map((f) => plan.columns.get(f)?.field.dbName);
    return columns.every((c): c is string => c !== undefined) ? columns : undefined;
  }

  private renderTableArgs(plan: ModelPlan): string[] {
    const { model } = plan;
    // `@ignore` columns are declared on the table only, and excluded from the mapping in `__mapper_args__`.
    const ignored = [...plan.columns.values()].filter((c) => c.field.isIgnored);
    const args = [...this.tableConstraints(plan), ...(model.schema === null ? [] : [`{"schema": ${pyString(model.schema)}}`])];
    if (ignored.length === 0 && args.length === 0) return [];
    if (ignored.length === 0 && args.length === 1 && model.schema !== null) return [`    __table_args__ = ${args[0]}`];
    return [
      '    __table_args__ = (',
      ...ignored.flatMap((c) => [...comment(c.field.documentation, '        '), `        ${this.renderCoreColumn(plan, c)},`]),
      ...args.map((a) => `        ${a},`),
      '    )',
    ];
  }

  /** Composite primary key, uniques, indexes and composite foreign keys. */
  private tableConstraints(plan: ModelPlan): string[] {
    const { model } = plan;
    const args: string[] = [];
    const constraint = (kind: string, fields: readonly string[], render: (columns: string) => string) => {
      const columns = this.dbColumns(plan, fields);
      if (columns === undefined) {
        this.diagnostics.warning('CONSTRAINT_SKIPPED', `${kind} on (${fields.join(', ')}) uses an omitted column`, { model: model.name });
        return;
      }
      args.push(render(columns.map(pyString).join(', ')));
    };
    if (model.primaryKey !== null && model.primaryKey.fields.length > 1) {
      const { dbName } = model.primaryKey;
      constraint('Primary key', model.primaryKey.fields, (cols) => `sa.PrimaryKeyConstraint(${cols}, name=${pyString(dbName)})`);
    }
    for (const unique of model.uniques) {
      constraint('Unique constraint', unique.fields, (cols) => `sa.UniqueConstraint(${cols}, name=${pyString(unique.dbName)})`);
    }
    for (const index of model.indexes) {
      const prefix = index.kind === 'fulltext' ? ', mysql_prefix="FULLTEXT"' : '';
      constraint('Index', index.fields, (cols) => `sa.Index(${pyString(index.dbName)}, ${cols}${prefix})`);
    }
    for (const relation of this.ir.relations) {
      if (relation.kind === 'many-to-many' || relation.from.model !== model.name || relation.fields.length < 2) continue;
      const target = this.models.get(relation.to.model);
      const local = this.dbColumns(plan, relation.fields);
      const remote = target === undefined ? undefined : this.dbColumns(target, relation.references);
      if (target === undefined || local === undefined || remote === undefined) continue;
      const refs = remote.map((c) => pyString(`${tableRef(target.model)}.${c}`));
      const options = this.foreignKeyOptions(relation);
      args.push(`sa.ForeignKeyConstraint([${local.map(pyString).join(', ')}], [${refs.join(', ')}], ${options.join(', ')})`);
    }
    return args;
  }

  private renderColumn(plan: ModelPlan, column: ColumnPlan): string {
    const args = [...(column.field.dbName === column.attr ? [] : [pyString(column.field.dbName)]), ...this.columnOptions(plan, column)];
    this.use(column.py, ...args);
    return `    ${column.attr}: Mapped[${column.py}] = mapped_column(${args.join(', ')})`;
  }

  /** Type, foreign key, key and default arguments, shared by `mapped_column()` and `sa.Column()`. */
  private columnOptions(plan: ModelPlan, column: ColumnPlan): string[] {
    const { field } = column;
    const args = [column.sa];
    for (const fk of this.singleColumnForeignKeys(plan.model, field.name)) args.push(fk);
    const primaryKey = plan.model.primaryKey?.fields ?? [];
    if (primaryKey.includes(field.name)) args.push('primary_key=True');
    args.push(...this.renderDefault(plan.model, field));
    // SQLAlchemy makes a lone integer primary key SERIAL/AUTO_INCREMENT unless told otherwise; Prisma does not.
    const isInteger = field.kind === 'scalar' && (field.type === 'Int' || field.type === 'BigInt');
    const isAutoincrement = field.default?.kind === 'function' && field.default.name === 'autoincrement';
    if (primaryKey.length === 1 && primaryKey[0] === field.name && isInteger && !isAutoincrement) args.push('autoincrement=False');
    return args;
  }

  private singleColumnForeignKeys(model: IrModel, field: string): string[] {
    const keys: string[] = [];
    for (const relation of this.ir.relations) {
      if (relation.kind === 'many-to-many' || relation.from.model !== model.name) continue;
      if (relation.fields.length !== 1 || relation.fields[0] !== field) continue;
      const target = this.models.get(relation.to.model);
      const column = target === undefined ? undefined : this.dbColumns(target, relation.references)?.[0];
      if (target === undefined || column === undefined) continue;
      keys.push(`sa.ForeignKey(${[pyString(`${tableRef(target.model)}.${column}`), ...this.foreignKeyOptions(relation)].join(', ')})`);
    }
    return keys;
  }

  private foreignKeyOptions(relation: IrForeignKeyRelation): string[] {
    return [
      ...actions(relation.onDelete, relation.onUpdate),
      `name=${pyString(relation.dbName)}`,
      ...(this.cyclic.has(relation) ? ['use_alter=True'] : []),
    ];
  }

  private renderDefault(model: IrModel, field: IrColumnField): string[] {
    const at = { model: model.name, field: field.name };
    if (field.kind === 'scalar' && field.isUpdatedAt) return ['default=sa.func.now()', 'onupdate=sa.func.now()'];
    const value = field.default;
    if (value === null) return [];
    if (value.kind === 'literal') {
      if (Array.isArray(value.value) || (typeof value.value === 'object' && value.value !== null)) {
        this.diagnostics.warning('DEFAULT_SKIPPED', 'List defaults are not rendered', at);
        return [];
      }
      if (field.kind === 'enum') {
        const stored = this.ir.enums.find((e) => e.name === field.type)?.values.find((v) => v.name === value.value)?.dbName;
        return [`server_default=${pyString(stored ?? String(value.value))}`];
      }
      if (typeof value.value === 'boolean') return [`server_default=${value.value ? 'sa.true()' : 'sa.false()'}`];
      if (['Int', 'BigInt', 'Float', 'Decimal'].includes(field.type)) return [`server_default=sa.text(${pyString(String(value.value))})`];
      return [`server_default=${pyString(String(value.value))}`];
    }
    switch (value.name) {
      case 'autoincrement':
        return ['autoincrement=True'];
      case 'now':
        return [`server_default=${this.nowDefault(field)}`];
      case 'dbgenerated': {
        const [expression] = value.args;
        return [typeof expression === 'string' ? `server_default=sa.text(${pyString(expression)})` : 'server_default=sa.FetchedValue()'];
      }
      case 'uuid':
        if (value.args.length === 0 || value.args[0] === 4) {
          this.use('uuid.');
          return ['default=lambda: str(uuid.uuid4())'];
        }
        break;
      case 'sequence':
        return ['server_default=sa.FetchedValue()'];
    }
    this.diagnostics.warning(
      'DEFAULT_SKIPPED',
      `@default(${value.name}(${value.args.map((a) => JSON.stringify(a)).join(', ')})) is generated by Prisma Client and has no Python equivalent here`,
      at,
    );
    return [];
  }

  /**
   * `@default(now())`. MySQL needs `CURRENT_TIMESTAMP(p)` with the column's own
   * fractional precision (as Prisma Migrate writes it); SQLAlchemy would emit `(now())`.
   */
  private nowDefault(field: IrColumnField): string {
    if (this.dialect !== 'mysql' || field.kind !== 'scalar') return 'sa.func.now()';
    const native = field.nativeType;
    if (native === null) return 'sa.text("CURRENT_TIMESTAMP(3)")';
    if (native.name !== 'DateTime' && native.name !== 'Timestamp') return 'sa.func.now()';
    return `sa.text(${pyString(`CURRENT_TIMESTAMP${native.args[0] === undefined ? '' : `(${native.args[0]})`}`)})`;
  }

  /** `back_populates` to the other side, unless that side is an `@ignore` field. */
  private backPopulates(other: { readonly model: string; readonly field: string }): string[] {
    const plan = this.models.get(other.model);
    if (plan?.model.fields.find((f) => f.name === other.field)?.isIgnored) return [];
    return [`back_populates=${pyString(plan?.attrs.get(other.field) ?? other.field)}`];
  }

  private renderRelationship(plan: ModelPlan, field: IrRelationField): string[] {
    const relation = findRelation(this.ir, plan.model.name, field.name);
    const attr = plan.attrs.get(field.name) ?? field.name;
    const target = this.models.get(field.type);
    if (relation === undefined || target === undefined || target.tableVar !== null) return [];
    const annotation = field.isList ? `list[${target.className}]` : field.isRequired ? target.className : `Optional[${target.className}]`;
    this.use(annotation);
    const args = relation.kind === 'many-to-many' ? this.manyToManyArgs(relation, plan, field) : this.foreignKeyArgs(relation, plan, field);
    if (args === undefined) return [];
    return [`    ${attr}: Mapped[${annotation}] = relationship(${args.join(', ')})`];
  }

  private foreignKeyArgs(relation: IrForeignKeyRelation, plan: ModelPlan, field: IrRelationField): string[] | undefined {
    const owner = this.models.get(relation.from.model);
    const target = this.models.get(relation.to.model);
    if (owner === undefined || target === undefined) return undefined;
    const isOwnerSide = relation.from.model === plan.model.name && relation.from.field === field.name;
    const other = isOwnerSide ? relation.to : relation.from;
    const fkAttrs = relation.fields.map((f) => {
      const column = owner.columns.get(f);
      return column?.field.isIgnored === false ? column.attr : undefined;
    });
    if (!fkAttrs.every((a) => a !== undefined)) {
      this.diagnostics.warning('RELATIONSHIP_SKIPPED', `Relation "${relation.name}" uses an omitted foreign-key column`, {
        model: plan.model.name,
        field: field.name,
      });
      return undefined;
    }
    const args = [
      ...this.backPopulates(other),
      `foreign_keys=${pyString(`[${fkAttrs.map((a) => `${owner.className}.${a}`).join(', ')}]`)}`,
    ];
    if (relation.isSelfRelation && isOwnerSide) {
      const remote = relation.references.map((r) => `${target.className}.${target.columns.get(r)?.attr ?? r}`);
      args.push(`remote_side=${pyString(`[${remote.join(', ')}]`)}`);
    }
    return args;
  }

  private manyToManyArgs(relation: IrManyToManyRelation, plan: ModelPlan, field: IrRelationField): string[] | undefined {
    const variable = this.tableVars.get(relation.name);
    if (variable === undefined) return undefined;
    const isA = relation.a.model === plan.model.name && relation.a.field === field.name;
    const other = isA ? relation.b : relation.a;
    const args = [`secondary=${variable}`, ...this.backPopulates(other)];
    if (relation.isSelfRelation) {
      // Each side's own key is in its own column (A for side a), the related key in the other.
      const key = plan.columns.get(relation.joinTable.columns[0].references)?.attr ?? 'id';
      const [own, related] = isA ? ['A', 'B'] : ['B', 'A'];
      args.push(
        `primaryjoin=lambda: ${plan.className}.${key} == ${variable}.c.${own}`,
        `secondaryjoin=lambda: ${plan.className}.${key} == ${variable}.c.${related}`,
      );
    }
    return args;
  }

  /** `__mapper_args__`: `@ignore` columns to leave unmapped, and the primary key of a model without `@id`. */
  private renderMapperArgs(plan: ModelPlan): string[] {
    const args: string[] = [];
    const ignored = [...plan.columns.values()].filter((c) => c.field.isIgnored);
    if (ignored.length > 0) args.push(`"exclude_properties": [${ignored.map((c) => pyString(c.field.dbName)).join(', ')}]`);
    const primaryKey = plan.model.primaryKey === null ? this.mapperPrimaryKey(plan) : undefined;
    if (primaryKey !== undefined) args.push(`"primary_key": [${primaryKey.join(', ')}]`);
    return args.length === 0 ? [] : ['', `    __mapper_args__ = {${args.join(', ')}}`];
  }

  /** Models identified only by a unique constraint need an explicit mapper primary key. */
  private mapperPrimaryKey(plan: ModelPlan): string[] | undefined {
    const isMapped = (f: string) => plan.columns.get(f)?.field.isIgnored === false;
    const unique = plan.model.uniques.find((u) => u.fields.every(isMapped));
    if (unique === undefined) {
      this.diagnostics.error('NO_PRIMARY_KEY', 'No @id or usable @unique; SQLAlchemy cannot map the model', { model: plan.model.name });
      return undefined;
    }
    this.diagnostics.info(
      'PRIMARY_KEY_FROM_UNIQUE',
      `No @id; the unique constraint on (${unique.fields.join(', ')}) is used as the mapper primary key`,
      { model: plan.model.name },
    );
    return unique.fields.map((f) => plan.columns.get(f)?.attr ?? f);
  }
}

function generate(ir: IrSchema, options?: SqlAlchemyOptions): AdapterOutput {
  const provider = options?.provider ?? ir.provider;
  if (provider === 'mongodb') {
    const diagnostics = new DiagnosticBag();
    diagnostics.error('UNSUPPORTED_PROVIDER', 'SQLAlchemy needs a SQL database, not "mongodb"');
    return { files: [], diagnostics: diagnostics.items };
  }
  const dialect = provider !== null && Object.hasOwn(DIALECTS, provider) ? DIALECTS[provider]! : 'generic';
  const output = new SqlAlchemyGenerator(ir, dialect).run();
  if (dialect === 'generic') {
    const message =
      provider === null
        ? 'The schema has no datasource; generic SQLAlchemy types are used'
        : `No dialect-specific mapping for "${provider}"; generic SQLAlchemy types are used`;
    return { files: output.files, diagnostics: [{ severity: 'info', code: 'GENERIC_DIALECT', message }, ...output.diagnostics] };
  }
  return output;
}

export const sqlalchemyAdapter: Adapter<SqlAlchemyOptions> = { name: 'sqlalchemy', generate };
