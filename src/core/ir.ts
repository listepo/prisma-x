/**
 * The neutral intermediate representation (IR) of a Prisma schema.
 *
 * It describes the data model in Prisma's own terms (scalar types, native
 * types, relations, database names) with Prisma's defaults already resolved,
 * e.g. effective table/column/constraint names and referential actions. It has
 * no knowledge of any output target; adapters map it to their ecosystem.
 */
import type { JsonValue } from '../dmmf.js';

/** Prisma scalar types. */
export type ScalarType = 'String' | 'Boolean' | 'Int' | 'BigInt' | 'Float' | 'Decimal' | 'DateTime' | 'Json' | 'Bytes';

export type ReferentialAction = 'Cascade' | 'Restrict' | 'NoAction' | 'SetNull' | 'SetDefault';

export interface IrSchema {
  /** Active datasource provider (`postgresql`, `mysql`, `sqlite`, ...); null without a datasource. */
  readonly provider: string | null;
  /** Schemas listed on the datasource (multi-schema), usually empty. */
  readonly schemas: readonly string[];
  readonly enums: readonly IrEnum[];
  readonly models: readonly IrModel[];
  readonly relations: readonly IrRelation[];
}

export interface IrEnumValue {
  readonly name: string;
  /** Stored value: `@map` or the name. */
  readonly dbName: string;
}

export interface IrEnum {
  readonly name: string;
  /** Database type name: `@@map` or the name. */
  readonly dbName: string;
  readonly values: readonly IrEnumValue[];
  readonly documentation: string | null;
}

export interface IrModel {
  readonly name: string;
  /** Table name: `@@map` or the model name. */
  readonly dbName: string;
  /** `@@schema`, or null. */
  readonly schema: string | null;
  readonly documentation: string | null;
  /** All fields in declaration order, including relation and unsupported fields. */
  readonly fields: readonly IrField[];
  /** `@id` / `@@id`. Null when the model is only identified by a unique constraint. */
  readonly primaryKey: IrPrimaryKey | null;
  /** `@unique` / `@@unique`. */
  readonly uniques: readonly IrIndex[];
  /** `@@index` and `@@fulltext`. */
  readonly indexes: readonly IrIndex[];
  /** `@@ignore`: not part of Prisma Client, but the table exists in the database. */
  readonly isIgnored: boolean;
}

export interface IrPrimaryKey {
  /** Prisma name of a compound id (`name:`), or null. */
  readonly name: string | null;
  /** Constraint name: `map:` or Prisma's default `<table>_pkey`. */
  readonly dbName: string;
  /** Field names, in key order. */
  readonly fields: readonly string[];
}

export interface IrIndex {
  readonly kind: 'unique' | 'normal' | 'fulltext';
  readonly name: string | null;
  /** Constraint name: `map:` or Prisma's default (`<table>_<columns>_key` / `_idx`). */
  readonly dbName: string;
  readonly fields: readonly string[];
  readonly isDefinedOnField: boolean;
}

export type IrDefault =
  | { readonly kind: 'literal'; readonly value: JsonValue; readonly generatedBy: 'database' }
  | {
      readonly kind: 'function';
      /** `autoincrement`, `now`, `uuid`, `cuid`, `nanoid`, `ulid`, `dbgenerated`, `sequence`, ... */
      readonly name: string;
      readonly args: readonly JsonValue[];
      /**
       * Whether the database fills the value (`autoincrement()`, `now()`,
       * `dbgenerated()`, literals) or Prisma Client does (`uuid()`, `cuid()`, ...),
       * in which case the column has no database default.
       */
      readonly generatedBy: 'database' | 'client';
    };

export interface IrNativeType {
  /** Native type name without the `@db.` prefix, e.g. `VarChar`. */
  readonly name: string;
  readonly args: readonly string[];
}

interface IrFieldBase {
  readonly name: string;
  readonly isList: boolean;
  readonly isRequired: boolean;
  readonly documentation: string | null;
  /** `@ignore`: not part of Prisma Client, but the column (or foreign key) exists in the database. */
  readonly isIgnored: boolean;
}

interface IrColumnFieldBase extends IrFieldBase {
  /** Column name: `@map` or the field name. */
  readonly dbName: string;
  readonly isId: boolean;
  readonly isUnique: boolean;
  readonly default: IrDefault | null;
  /** True for scalar fields listed in a relation's `fields: [...]`. */
  readonly isForeignKey: boolean;
}

export interface IrScalarField extends IrColumnFieldBase {
  readonly kind: 'scalar';
  readonly type: ScalarType;
  readonly nativeType: IrNativeType | null;
  readonly isUpdatedAt: boolean;
}

export interface IrEnumField extends IrColumnFieldBase {
  readonly kind: 'enum';
  /** Name of the enum. */
  readonly type: string;
}

export interface IrRelationField extends IrFieldBase {
  readonly kind: 'relation';
  /** Name of the related model. */
  readonly type: string;
  /** Name of the relation (`IrRelation.name`). */
  readonly relation: string;
}

/** `Unsupported("...")`: a column whose type Prisma cannot represent. */
export interface IrUnsupportedField extends IrFieldBase {
  readonly kind: 'unsupported';
  readonly dbName: string;
  /** The quoted database type, e.g. `circle`. */
  readonly type: string;
}

export type IrColumnField = IrScalarField | IrEnumField;
export type IrField = IrScalarField | IrEnumField | IrRelationField | IrUnsupportedField;

export interface IrRelationEnd {
  readonly model: string;
  readonly field: string;
  readonly isList: boolean;
  readonly isRequired: boolean;
}

/** A one-to-one or one-to-many relation backed by a foreign key. */
export interface IrForeignKeyRelation {
  readonly kind: 'one-to-one' | 'one-to-many';
  readonly name: string;
  readonly isSelfRelation: boolean;
  /** The side that holds the foreign key (the "many" side of one-to-many). */
  readonly from: IrRelationEnd;
  /** The referenced side. */
  readonly to: IrRelationEnd;
  /** Foreign-key field names on `from.model`. */
  readonly fields: readonly string[];
  /** Referenced field names on `to.model`, in the same order. */
  readonly references: readonly string[];
  /** True when `references` is exactly the primary key of `to.model`. */
  readonly referencesPrimaryKey: boolean;
  /** Effective action: explicit, or Prisma's default (SetNull if optional, else Restrict). */
  readonly onDelete: ReferentialAction;
  /** Effective action: explicit, or Prisma's default (Cascade). */
  readonly onUpdate: ReferentialAction;
  /** Foreign-key constraint name: `@relation(map: ...)` or Prisma's default `<table>_<columns>_fkey`. */
  readonly dbName: string;
  /**
   * A relation field has `@ignore` or a side's model has `@@ignore`: Prisma
   * Client has no relation, but the foreign key exists in the database.
   */
  readonly isIgnored: boolean;
}

export interface IrJoinColumn {
  /** `A` or `B`. */
  readonly name: 'A' | 'B';
  readonly model: string;
  /** The referenced single-field primary key of `model`; the column has its type. */
  readonly references: string;
}

/** The table Prisma creates for an implicit many-to-many relation. */
export interface IrJoinTable {
  /** `_<RelationName>`. */
  readonly dbName: string;
  /** Schema of model A's table, or null. */
  readonly schema: string | null;
  readonly columns: readonly [IrJoinColumn, IrJoinColumn];
  /** How Prisma makes (A, B) unique: a primary key on PostgreSQL, a unique index elsewhere. */
  readonly uniqueness: { readonly kind: 'primaryKey' | 'unique'; readonly dbName: string };
  /** Name of the index on B. */
  readonly indexDbName: string;
  /** Both foreign keys cascade on delete and update. */
  readonly foreignKeyDbNames: readonly [string, string];
}

/** An implicit many-to-many relation (two list fields, no explicit join model). */
export interface IrManyToManyRelation {
  readonly kind: 'many-to-many';
  readonly name: string;
  readonly isSelfRelation: boolean;
  /**
   * The side stored in column `A`: the model whose name sorts first, or for
   * self-relations the field whose name sorts first. Each side's own primary
   * key is stored in its own column.
   */
  readonly a: IrRelationEnd;
  readonly b: IrRelationEnd;
  readonly joinTable: IrJoinTable;
  /** A relation field has `@ignore` or a side's model has `@@ignore`; the join table still exists. */
  readonly isIgnored: boolean;
}

export type IrRelation = IrForeignKeyRelation | IrManyToManyRelation;
