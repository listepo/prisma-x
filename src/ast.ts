/**
 * A compact, typed AST of a Prisma schema, derived from the DMMF datamodel
 * plus the datasource configuration.
 */
import type { DmmfDatamodel, DmmfField, DmmfFieldDefault, DmmfIndex, DmmfModel, JsonValue } from './dmmf.js';
import { recoverModels, type RecoveredModel } from './source-recovery.js';

export interface SchemaAst {
  readonly datasources: readonly Datasource[];
  readonly models: readonly Model[];
  readonly enums: readonly Enum[];
  readonly relations: readonly Relation[];
}

export interface Datasource {
  readonly name: string;
  readonly provider: string;
  readonly activeProvider: string;
  readonly schemas: readonly string[];
}

export interface EnumValue {
  readonly name: string;
  readonly dbName: string | null;
}

export interface Enum {
  readonly name: string;
  readonly dbName: string | null;
  readonly values: readonly EnumValue[];
  /** Text of the `///` doc comment, if any. */
  readonly documentation: string | null;
}

export type IndexType = 'id' | 'unique' | 'normal' | 'fulltext';

/** A primary key, unique constraint or index, with field-level ones included. */
export interface Index {
  readonly type: IndexType;
  /** Prisma-level name (`name:` argument), used for compound ids/uniques. */
  readonly name: string | null;
  /** Database constraint name from `map:`; null when the engine default applies. */
  readonly dbName: string | null;
  readonly fields: readonly string[];
  /** True for `@id`/`@unique` on a field, false for block attributes. */
  readonly isDefinedOnField: boolean;
}

export interface Model {
  readonly name: string;
  readonly dbName: string | null;
  /** Database schema from `@@schema`, for multi-schema datasources. */
  readonly schema: string | null;
  readonly documentation: string | null;
  readonly fields: readonly Field[];
  readonly primaryKey: { readonly name: string | null; readonly fields: readonly string[] } | null;
  readonly uniqueIndexes: readonly { readonly name: string | null; readonly fields: readonly string[] }[];
  /** All ids, uniques and indexes of the model, in engine order. */
  readonly indexes: readonly Index[];
  /**
   * `@@ignore`: left out of Prisma Client, but the table exists. The engine
   * omits these models; they are recovered from the source.
   */
  readonly isIgnored: boolean;
}

export type FieldDefault =
  | { readonly kind: 'literal'; readonly value: JsonValue }
  | { readonly kind: 'function'; readonly name: string; readonly args: readonly JsonValue[] };

interface BaseField {
  readonly name: string;
  /** Column name from `@map`; null when it equals `name` or the field is a relation. */
  readonly dbName: string | null;
  readonly type: string;
  readonly isList: boolean;
  readonly isRequired: boolean;
  readonly isUnique: boolean;
  readonly isId: boolean;
  /** True for scalar fields that back a relation (foreign keys). */
  readonly isReadOnly: boolean;
  readonly isUpdatedAt: boolean;
  readonly default: FieldDefault | null;
  readonly documentation: string | null;
  /**
   * `@ignore`: left out of Prisma Client, but the column exists. The engine
   * omits these fields; they are recovered from the source.
   */
  readonly isIgnored: boolean;
}

export interface ScalarField extends BaseField {
  readonly kind: 'scalar';
  readonly nativeType: { readonly name: string; readonly args: readonly string[] } | null;
}

export interface EnumField extends BaseField {
  readonly kind: 'enum';
}

export interface RelationField extends BaseField {
  readonly kind: 'relation';
  readonly relationName: string;
  /** Local foreign-key fields; empty on the side that does not own the foreign key. */
  readonly fromFields: readonly string[];
  readonly toFields: readonly string[];
  readonly onDelete: string | null;
  readonly onUpdate: string | null;
  /**
   * Foreign-key constraint name from `@relation(map: ...)`; null when Prisma's
   * default applies. Read from the source: the engine's datamodel lacks it.
   */
  readonly foreignKeyDbName: string | null;
}

/**
 * A field of type `Unsupported("...")`. The engine leaves these out of the
 * DMMF, so they are recovered from the schema source; `type` is the quoted
 * database type, e.g. `"circle"`.
 */
export interface UnsupportedField extends BaseField {
  readonly kind: 'unsupported';
}

export type Field = ScalarField | EnumField | RelationField | UnsupportedField;

export type RelationKind = 'one-to-one' | 'one-to-many' | 'many-to-many';

export interface RelationSide {
  readonly model: string;
  readonly field: string;
  readonly isList: boolean;
  readonly isRequired: boolean;
}

export interface Relation {
  readonly name: string;
  readonly kind: RelationKind;
  readonly isSelfRelation: boolean;
  /** `sides[0]` owns the foreign key when there is one. */
  readonly sides: readonly [RelationSide, RelationSide];
  readonly foreignKey: {
    readonly fields: readonly string[];
    readonly references: readonly string[];
    readonly onDelete: string | null;
    readonly onUpdate: string | null;
    /** Constraint name from `@relation(map: ...)` on the owning side, or null for Prisma's default. */
    readonly dbName: string | null;
  } | null;
  /** A side's field has `@ignore` or a side's model has `@@ignore`: the relation is not in Prisma Client. */
  readonly isIgnored: boolean;
}

function toDefault(value: DmmfFieldDefault | undefined): FieldDefault | null {
  if (value === undefined) return null;
  if (typeof value === 'object' && !Array.isArray(value) && 'name' in value) {
    return { kind: 'function', name: value.name, args: value.args };
  }
  return { kind: 'literal', value: value as JsonValue };
}

interface FieldExtras {
  readonly isIgnored: boolean;
  readonly foreignKeyDbName: string | null;
}

function toField(field: DmmfField, extras: FieldExtras): Field {
  const base: BaseField = {
    name: field.name,
    dbName: field.dbName ?? null,
    type: field.type,
    isList: field.isList,
    isRequired: field.isRequired,
    isUnique: field.isUnique,
    isId: field.isId,
    isReadOnly: field.isReadOnly,
    isUpdatedAt: field.isUpdatedAt,
    default: toDefault(field.default),
    documentation: field.documentation ?? null,
    isIgnored: extras.isIgnored,
  };
  switch (field.kind) {
    case 'scalar':
      return {
        ...base,
        kind: 'scalar',
        nativeType: field.nativeType ? { name: field.nativeType[0], args: field.nativeType[1] } : null,
      };
    case 'enum':
      return { ...base, kind: 'enum' };
    case 'unsupported':
      return { ...base, kind: 'unsupported' };
    case 'object':
      return {
        ...base,
        kind: 'relation',
        relationName: field.relationName ?? '',
        fromFields: field.relationFromFields ?? [],
        toFields: field.relationToFields ?? [],
        onDelete: field.relationOnDelete ?? null,
        onUpdate: field.relationOnUpdate ?? null,
        foreignKeyDbName: extras.foreignKeyDbName,
      };
  }
}

interface RelationEnd {
  readonly model: string;
  readonly field: RelationField;
}

function buildRelations(models: readonly Model[]): Relation[] {
  const ignoredModels = new Set(models.filter((m) => m.isIgnored).map((m) => m.name));
  // Relation names are only unique per model pair, so key on both.
  const groups = new Map<string, RelationEnd[]>();
  for (const model of models) {
    for (const field of model.fields) {
      if (field.kind !== 'relation') continue;
      const pair = [model.name, field.type].sort().join('\u0000');
      const key = `${field.relationName}\u0000${pair}`;
      const group = groups.get(key) ?? [];
      group.push({ model: model.name, field });
      groups.set(key, group);
    }
  }

  const relations: Relation[] = [];
  for (const ends of groups.values()) {
    const [first, second] = ends;
    if (ends.length !== 2 || first === undefined || second === undefined) {
      throw new Error(`Relation "${ends[0]?.field.relationName}" does not have exactly two sides`);
    }
    const [owner, other] = second.field.fromFields.length > 0 ? [second, first] : [first, second];
    const lists = Number(owner.field.isList) + Number(other.field.isList);
    const side = (end: RelationEnd): RelationSide => ({
      model: end.model,
      field: end.field.name,
      isList: end.field.isList,
      isRequired: end.field.isRequired,
    });
    relations.push({
      name: owner.field.relationName,
      kind: lists === 2 ? 'many-to-many' : lists === 1 ? 'one-to-many' : 'one-to-one',
      isSelfRelation: owner.model === other.model,
      sides: [side(owner), side(other)],
      foreignKey:
        owner.field.fromFields.length > 0
          ? {
              fields: owner.field.fromFields,
              references: owner.field.toFields,
              onDelete: owner.field.onDelete,
              onUpdate: owner.field.onUpdate,
              dbName: owner.field.foreignKeyDbName,
            }
          : null,
      isIgnored: [owner, other].some((end) => end.field.isIgnored || ignoredModels.has(end.model)),
    });
  }
  return relations;
}

function toIndex(index: DmmfIndex): Index {
  return {
    type: index.type as IndexType,
    name: index.name ?? null,
    dbName: index.dbName ?? null,
    fields: index.fields.map((f) => f.name),
    isDefinedOnField: index.isDefinedOnField,
  };
}

/**
 * The engine's fields plus the recovered ones it omits (`@ignore`,
 * `Unsupported(...)`), in declaration order.
 */
function fieldsOf(model: DmmfModel, recovered: RecoveredModel | undefined): Field[] {
  const known = new Set(model.fields.map((f) => f.name));
  const declared = recovered?.model.fields ?? [];
  const fields = [...model.fields, ...declared.filter((f) => !known.has(f.name))].map((f) =>
    toField(f, {
      isIgnored: recovered?.ignoredFields.has(f.name) ?? false,
      foreignKeyDbName: recovered?.foreignKeyNames.get(f.name) ?? null,
    }),
  );
  const order = new Map(declared.map((f, i) => [f.name, i]));
  const position = (f: Field) => order.get(f.name) ?? Number.MAX_SAFE_INTEGER;
  return fields.sort((a, b) => position(a) - position(b));
}

/**
 * Maps the DMMF datamodel to the AST. `source` is the schema text. It is
 * scanned for what the DMMF leaves out: `Unsupported(...)` and `@ignore`
 * fields, `@@ignore` models and `@relation(map: ...)` names.
 */
export function buildAst(datamodel: DmmfDatamodel, datasources: readonly Datasource[], source = ''): SchemaAst {
  const recovered = source === '' ? [] : recoverModels(source, datamodel.enums.map((e) => e.name), datamodel.types.map((t) => t.name));
  const byName = new Map(recovered.map((r) => [r.model.name, r]));
  const toModel = (model: DmmfModel, indexes: readonly DmmfIndex[], isIgnored: boolean): Model => ({
    name: model.name,
    dbName: model.dbName,
    schema: model.schema ?? null,
    documentation: model.documentation ?? null,
    fields: fieldsOf(model, byName.get(model.name)),
    primaryKey: model.primaryKey,
    uniqueIndexes: model.uniqueIndexes,
    indexes: indexes.filter((i) => i.model === model.name).map(toIndex),
    isIgnored,
  });
  const models = datamodel.models.map((m) => toModel(m, datamodel.indexes ?? [], false));
  const known = new Set(models.map((m) => m.name));
  for (const r of recovered) {
    if (r.isIgnored && !known.has(r.model.name)) models.push(toModel(r.model, r.indexes, true));
  }
  // Declaration order, with recovered models in place.
  const order = new Map(recovered.map((r, i) => [r.model.name, i]));
  const position = (m: Model) => order.get(m.name) ?? Number.MAX_SAFE_INTEGER;
  models.sort((a, b) => position(a) - position(b));
  const enums: Enum[] = datamodel.enums.map((e) => ({
    name: e.name,
    dbName: e.dbName,
    values: e.values.map((v) => ({ name: v.name, dbName: v.dbName })),
    documentation: e.documentation ?? null,
  }));
  return { datasources, models, enums, relations: buildRelations(models) };
}
