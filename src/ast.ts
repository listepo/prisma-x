/**
 * A compact, typed AST of a Prisma schema, derived from the DMMF datamodel
 * plus the datasource configuration.
 */
import type { DmmfDatamodel, DmmfField, DmmfFieldDefault, JsonValue } from './dmmf.js';

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
}

export interface Model {
  readonly name: string;
  readonly dbName: string | null;
  readonly fields: readonly Field[];
  readonly primaryKey: { readonly name: string | null; readonly fields: readonly string[] } | null;
  readonly uniqueIndexes: readonly { readonly name: string | null; readonly fields: readonly string[] }[];
}

export type FieldDefault =
  | { readonly kind: 'literal'; readonly value: JsonValue }
  | { readonly kind: 'function'; readonly name: string; readonly args: readonly JsonValue[] };

interface BaseField {
  readonly name: string;
  readonly type: string;
  readonly isList: boolean;
  readonly isRequired: boolean;
  readonly isUnique: boolean;
  readonly isId: boolean;
  /** True for scalar fields that back a relation (foreign keys). */
  readonly isReadOnly: boolean;
  readonly isUpdatedAt: boolean;
  readonly default: FieldDefault | null;
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
}

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
  } | null;
}

function toDefault(value: DmmfFieldDefault | undefined): FieldDefault | null {
  if (value === undefined) return null;
  if (typeof value === 'object' && !Array.isArray(value) && 'name' in value) {
    return { kind: 'function', name: value.name, args: value.args };
  }
  return { kind: 'literal', value: value as JsonValue };
}

function toField(field: DmmfField): Field {
  const base: BaseField = {
    name: field.name,
    type: field.type,
    isList: field.isList,
    isRequired: field.isRequired,
    isUnique: field.isUnique,
    isId: field.isId,
    isReadOnly: field.isReadOnly,
    isUpdatedAt: field.isUpdatedAt,
    default: toDefault(field.default),
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
      };
  }
}

interface RelationEnd {
  readonly model: string;
  readonly field: RelationField;
}

function buildRelations(models: readonly Model[]): Relation[] {
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
            }
          : null,
    });
  }
  return relations;
}

export function buildAst(datamodel: DmmfDatamodel, datasources: readonly Datasource[]): SchemaAst {
  const models: Model[] = datamodel.models.map((model) => ({
    name: model.name,
    dbName: model.dbName,
    fields: model.fields.map(toField),
    primaryKey: model.primaryKey,
    uniqueIndexes: model.uniqueIndexes,
  }));
  const enums: Enum[] = datamodel.enums.map((e) => ({ name: e.name, dbName: e.dbName, values: e.values }));
  return { datasources, models, enums, relations: buildRelations(models) };
}
