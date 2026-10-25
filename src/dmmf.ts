/**
 * Typed shape of the DMMF datamodel as emitted by the engine.
 *
 * These are this library's own declarations of the JSON contract; they are not
 * re-exported wasm types.
 */

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type DmmfFieldKind = 'scalar' | 'object' | 'enum' | 'unsupported';

/** A default is either a literal or a function call such as `autoincrement()`. */
export type DmmfFieldDefault =
  | string
  | number
  | boolean
  | readonly JsonValue[]
  | { readonly name: string; readonly args: readonly JsonValue[] };

export interface DmmfField {
  readonly name: string;
  readonly kind: DmmfFieldKind;
  readonly isList: boolean;
  readonly isRequired: boolean;
  readonly isUnique: boolean;
  readonly isId: boolean;
  readonly isReadOnly: boolean;
  readonly hasDefaultValue: boolean;
  readonly type: string;
  readonly dbName?: string | null;
  /** `[typeName, args]`, e.g. `["VarChar", ["255"]]`. */
  readonly nativeType: readonly [string, readonly string[]] | null;
  readonly default?: DmmfFieldDefault;
  readonly relationName?: string;
  readonly relationFromFields?: readonly string[];
  readonly relationToFields?: readonly string[];
  readonly relationOnDelete?: string;
  readonly relationOnUpdate?: string;
  readonly isGenerated: boolean;
  readonly isUpdatedAt: boolean;
  readonly documentation?: string;
}

export interface DmmfPrimaryKey {
  readonly name: string | null;
  readonly fields: readonly string[];
}

export interface DmmfUniqueIndex {
  readonly name: string | null;
  readonly fields: readonly string[];
}

export interface DmmfModel {
  readonly name: string;
  readonly dbName: string | null;
  readonly schema: string | null;
  readonly fields: readonly DmmfField[];
  readonly primaryKey: DmmfPrimaryKey | null;
  readonly uniqueFields: readonly (readonly string[])[];
  readonly uniqueIndexes: readonly DmmfUniqueIndex[];
  readonly isGenerated: boolean;
  readonly documentation?: string;
}

export interface DmmfEnumValue {
  readonly name: string;
  readonly dbName: string | null;
}

export interface DmmfEnum {
  readonly name: string;
  readonly values: readonly DmmfEnumValue[];
  readonly dbName: string | null;
  readonly documentation?: string;
}

export interface DmmfIndex {
  readonly model: string;
  readonly type: string;
  readonly isDefinedOnField: boolean;
  readonly fields: readonly { readonly name: string }[];
  readonly name?: string;
  readonly dbName?: string;
}

export interface DmmfDatamodel {
  readonly models: readonly DmmfModel[];
  readonly enums: readonly DmmfEnum[];
  /** Composite types (MongoDB only). */
  readonly types: readonly DmmfModel[];
  readonly indexes: readonly DmmfIndex[];
}

/** The full DMMF document. `schema` and `mappings` are passed through untyped. */
export interface Dmmf {
  readonly datamodel: DmmfDatamodel;
  readonly schema: JsonValue;
  readonly mappings: JsonValue;
}
