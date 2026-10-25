/**
 * Builds the neutral IR from the parser's AST, resolving Prisma's defaults
 * (database names, constraint names, referential actions, join tables).
 */
import type { Field, FieldDefault, Index, Model, Relation, SchemaAst } from '../ast.js';
import type {
  IrColumnField,
  IrDefault,
  IrEnum,
  IrField,
  IrForeignKeyRelation,
  IrIndex,
  IrManyToManyRelation,
  IrModel,
  IrPrimaryKey,
  IrRelation,
  IrRelationEnd,
  IrSchema,
  ReferentialAction,
  ScalarType,
} from './ir.js';

/** Maximum identifier length per provider, as used by Prisma's naming rules. */
const MAX_IDENTIFIER_LENGTH: Readonly<Record<string, number>> = {
  postgresql: 63,
  cockroachdb: 63,
  mysql: 64,
  sqlserver: 128,
  mongodb: 127,
  sqlite: 10000,
};
const DEFAULT_MAX_IDENTIFIER_LENGTH = 63;

/** Default functions Prisma Client evaluates itself; the column gets no database default. */
const CLIENT_DEFAULTS = new Set(['uuid', 'cuid', 'nanoid', 'ulid']);

const REFERENTIAL_ACTIONS = new Set<string>(['Cascade', 'Restrict', 'NoAction', 'SetNull', 'SetDefault']);

/** Truncates to at most `maxBytes` UTF-8 bytes without splitting a character. */
function truncateBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let out = '';
  let bytes = 0;
  for (const ch of text) {
    bytes += Buffer.byteLength(ch);
    if (bytes > maxBytes) break;
    out += ch;
  }
  return out;
}

function truncateChars(text: string, maxChars: number): string {
  return Array.from(text).slice(0, maxChars).join('');
}

/** Prisma's constraint naming: `<base><suffix>` with `base` cut to fit the limit. */
function constraintName(base: string, suffix: string, limit: number): string {
  return truncateBytes(base, limit - suffix.length) + suffix;
}

function toDefault(value: FieldDefault | null): IrDefault | null {
  if (value === null) return null;
  if (value.kind === 'literal') return { kind: 'literal', value: value.value, generatedBy: 'database' };
  return {
    kind: 'function',
    name: value.name,
    args: value.args,
    generatedBy: CLIENT_DEFAULTS.has(value.name) ? 'client' : 'database',
  };
}

function toField(field: Field): IrField {
  const base = {
    name: field.name,
    isList: field.isList,
    isRequired: field.isRequired,
    documentation: field.documentation,
  };
  const column = {
    ...base,
    dbName: field.dbName ?? field.name,
    isId: field.isId,
    isUnique: field.isUnique,
    default: toDefault(field.default),
    isForeignKey: field.isReadOnly,
  };
  switch (field.kind) {
    case 'scalar':
      return {
        ...column,
        kind: 'scalar',
        type: field.type as ScalarType,
        nativeType: field.nativeType,
        isUpdatedAt: field.isUpdatedAt,
      };
    case 'enum':
      return { ...column, kind: 'enum', type: field.type };
    case 'relation':
      return { ...base, kind: 'relation', type: field.type, relation: field.relationName };
    case 'unsupported':
      return { ...base, kind: 'unsupported', dbName: field.dbName ?? field.name, type: field.type };
  }
}

/** The model's indexes, synthesized from field flags for ASTs that carry none. */
function indexesOf(model: Model): readonly Index[] {
  if (model.indexes.length > 0) return model.indexes;
  const indexes: Index[] = [];
  const ids = model.fields.filter((f) => f.isId).map((f) => f.name);
  if (model.primaryKey !== null) {
    indexes.push({ type: 'id', name: model.primaryKey.name, dbName: null, fields: model.primaryKey.fields, isDefinedOnField: false });
  } else if (ids.length > 0) {
    indexes.push({ type: 'id', name: null, dbName: null, fields: ids, isDefinedOnField: true });
  }
  for (const field of model.fields.filter((f) => f.isUnique)) {
    indexes.push({ type: 'unique', name: null, dbName: null, fields: [field.name], isDefinedOnField: true });
  }
  for (const unique of model.uniqueIndexes) {
    indexes.push({ type: 'unique', name: unique.name, dbName: null, fields: unique.fields, isDefinedOnField: false });
  }
  return indexes;
}

function buildModel(model: Model, limit: number): IrModel {
  const fields = model.fields.map(toField);
  const table = model.dbName ?? model.name;
  const columnOf = (name: string): string => {
    const field = fields.find((f) => f.name === name);
    return field !== undefined && field.kind !== 'relation' ? field.dbName : name;
  };
  const columns = (names: readonly string[]) => names.map(columnOf).join('_');

  let primaryKey: IrPrimaryKey | null = null;
  const uniques: IrIndex[] = [];
  const indexes: IrIndex[] = [];
  for (const index of indexesOf(model)) {
    switch (index.type) {
      case 'id':
        primaryKey = {
          name: index.name,
          dbName: index.dbName ?? constraintName(table, '_pkey', limit),
          fields: index.fields,
        };
        break;
      case 'unique':
        uniques.push({
          kind: 'unique',
          name: index.name,
          dbName: index.dbName ?? constraintName(`${table}_${columns(index.fields)}`, '_key', limit),
          fields: index.fields,
          isDefinedOnField: index.isDefinedOnField,
        });
        break;
      default:
        indexes.push({
          kind: index.type === 'fulltext' ? 'fulltext' : 'normal',
          name: index.name,
          dbName: index.dbName ?? constraintName(`${table}_${columns(index.fields)}`, '_idx', limit),
          fields: index.fields,
          isDefinedOnField: index.isDefinedOnField,
        });
    }
  }

  return {
    name: model.name,
    dbName: table,
    schema: model.schema,
    documentation: model.documentation,
    fields,
    primaryKey,
    uniques,
    indexes,
  };
}

function referentialAction(value: string | null, fallback: ReferentialAction): ReferentialAction {
  return value !== null && REFERENTIAL_ACTIONS.has(value) ? (value as ReferentialAction) : fallback;
}

function sameFields(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name, i) => name === b[i]);
}

function buildForeignKeyRelation(relation: Relation, models: ReadonlyMap<string, IrModel>, limit: number): IrForeignKeyRelation {
  const [from, to] = relation.sides;
  const fk = relation.foreignKey;
  const owner = models.get(from.model);
  const target = models.get(to.model);
  if (fk === null || owner === undefined || target === undefined) {
    throw new Error(`Relation "${relation.name}" has no foreign key or refers to an unknown model`);
  }
  const columns = fk.fields.map((name) => {
    const field = owner.fields.find((f) => f.name === name);
    return field !== undefined && field.kind !== 'relation' ? field.dbName : name;
  });
  return {
    kind: relation.kind === 'one-to-one' ? 'one-to-one' : 'one-to-many',
    name: relation.name,
    isSelfRelation: relation.isSelfRelation,
    from: { ...from },
    to: { ...to },
    fields: fk.fields,
    references: fk.references,
    referencesPrimaryKey: target.primaryKey !== null && sameFields(target.primaryKey.fields, fk.references),
    onDelete: referentialAction(fk.onDelete, from.isRequired ? 'Restrict' : 'SetNull'),
    onUpdate: referentialAction(fk.onUpdate, 'Cascade'),
    dbName: constraintName(`${owner.dbName}_${columns.join('_')}`, '_fkey', limit),
  };
}

function singlePrimaryKey(model: IrModel | undefined): IrColumnField {
  const name = model?.primaryKey?.fields.length === 1 ? model.primaryKey.fields[0] : undefined;
  const field = model?.fields.find((f) => f.name === name);
  if (field === undefined || (field.kind !== 'scalar' && field.kind !== 'enum')) {
    throw new Error(`Model "${model?.name}" in an implicit many-to-many relation needs a single-field id`);
  }
  return field;
}

function buildManyToManyRelation(
  relation: Relation,
  models: ReadonlyMap<string, IrModel>,
  provider: string | null,
  limit: number,
): IrManyToManyRelation {
  // Prisma's ordering: model A sorts first by name; for self-relations, by field name.
  const [first, second] = relation.sides;
  const key = (end: IrRelationEnd) => (relation.isSelfRelation ? end.field : end.model);
  const [a, b]: [IrRelationEnd, IrRelationEnd] = key(first) <= key(second) ? [first, second] : [second, first];
  const modelA = models.get(a.model);
  const table = truncateChars(`_${relation.name}`, limit);
  const maxTable = limit - '_fkey'.length - 2;
  const tableBytes = Buffer.byteLength(table);
  const uniqueness = provider === 'postgresql' ? ('primaryKey' as const) : ('unique' as const);
  const uniqueSuffix = uniqueness === 'primaryKey' ? '_AB_pkey' : '_AB_unique';
  return {
    kind: 'many-to-many',
    name: relation.name,
    isSelfRelation: relation.isSelfRelation,
    a: { ...a },
    b: { ...b },
    joinTable: {
      dbName: table,
      schema: modelA?.schema ?? null,
      columns: [
        { name: 'A', model: a.model, references: singlePrimaryKey(modelA).name },
        { name: 'B', model: b.model, references: singlePrimaryKey(models.get(b.model)).name },
      ],
      uniqueness: { kind: uniqueness, dbName: truncateChars(table, limit - uniqueSuffix.length) + uniqueSuffix },
      indexDbName: `${truncateChars(table, limit - 8)}_B_index`,
      // Mirrors the engine, which cuts at `>` for A and `>=` for B.
      foreignKeyDbNames: [
        `${tableBytes > maxTable ? truncateBytes(table, maxTable) : table}_A_fkey`,
        `${tableBytes >= maxTable ? truncateBytes(table, maxTable) : table}_B_fkey`,
      ],
    },
  };
}

/** Builds the IR from a parsed schema. Pure; does not touch the engine. */
export function buildIr(ast: SchemaAst): IrSchema {
  const datasource = ast.datasources[0];
  const provider = datasource?.activeProvider ?? null;
  const limit = (provider === null ? undefined : MAX_IDENTIFIER_LENGTH[provider]) ?? DEFAULT_MAX_IDENTIFIER_LENGTH;

  const enums: IrEnum[] = ast.enums.map((e) => ({
    name: e.name,
    dbName: e.dbName ?? e.name,
    values: e.values.map((v) => ({ name: v.name, dbName: v.dbName ?? v.name })),
    documentation: e.documentation,
  }));
  const models = ast.models.map((m) => buildModel(m, limit));
  const byName = new Map(models.map((m) => [m.name, m]));
  const relations: IrRelation[] = ast.relations.map((r) =>
    r.kind === 'many-to-many' ? buildManyToManyRelation(r, byName, provider, limit) : buildForeignKeyRelation(r, byName, limit),
  );

  return { provider, schemas: datasource?.schemas ?? [], enums, models, relations };
}
