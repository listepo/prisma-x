/** Target-neutral core: the IR, its builder, naming helpers and the adapter contract. */
export { buildIr } from './build.js';
export { splitWords, toSnakeCase, toCamelCase, toPascalCase } from './names.js';
export { DiagnosticBag, findRelation, formatDiagnostic } from './adapter.js';
export type {
  Adapter,
  AdapterOptions,
  AdapterOutput,
  AdapterDiagnostic,
  AdapterDiagnosticSeverity,
  GeneratedFile,
} from './adapter.js';
export type * from './ir.js';
