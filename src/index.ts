/**
 * Public API. Only this library's own functions and types are exported here;
 * the underlying wasm module and its types are deliberately kept internal.
 */
export { parseSchema, validate, getDmmf } from './parser.js';
export type { ParseResult, ParseSuccess, ParseFailure } from './parser.js';
export { SchemaError } from './errors.js';
export type { SchemaErrorCode, Diagnostic, SourceSpan, Position, Severity } from './errors.js';
export type {
  SchemaAst,
  Datasource,
  Model,
  Field,
  ScalarField,
  EnumField,
  RelationField,
  UnsupportedField,
  FieldDefault,
  Enum,
  EnumValue,
  Relation,
  RelationKind,
  RelationSide,
} from './ast.js';
export type {
  Dmmf,
  DmmfDatamodel,
  DmmfModel,
  DmmfField,
  DmmfFieldKind,
  DmmfFieldDefault,
  DmmfEnum,
  DmmfEnumValue,
  DmmfIndex,
  DmmfPrimaryKey,
  DmmfUniqueIndex,
  JsonValue,
} from './dmmf.js';
