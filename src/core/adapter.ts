/**
 * The contract between the core and output targets. An adapter turns the IR
 * into files and reports what it could not express as diagnostics; it never
 * throws for unsupported features.
 */
import type { IrRelation, IrSchema } from './ir.js';

export interface GeneratedFile {
  /** Relative path with `/` separators, e.g. `schema.rs`. */
  readonly path: string;
  readonly contents: string;
}

/**
 * - `error`: part of the requested output could not be produced (e.g. an
 *   unsupported provider or a skipped model).
 * - `warning`: output was produced without something from the schema (e.g. an
 *   omitted column or relation helper).
 * - `info`: a note about a mapping choice.
 */
export type AdapterDiagnosticSeverity = 'error' | 'warning' | 'info';

export interface AdapterDiagnostic {
  readonly severity: AdapterDiagnosticSeverity;
  /** Stable machine-readable code, e.g. `UNSUPPORTED_TYPE`. */
  readonly code: string;
  readonly message: string;
  readonly model?: string;
  readonly field?: string;
}

export interface AdapterOutput {
  readonly files: readonly GeneratedFile[];
  readonly diagnostics: readonly AdapterDiagnostic[];
}

export interface AdapterOptions {
  /** Overrides the datasource provider of the schema. */
  readonly provider?: string;
}

export interface Adapter<Options extends AdapterOptions = AdapterOptions> {
  /** Short name used by the CLI, e.g. `diesel`. */
  readonly name: string;
  generate(ir: IrSchema, options?: Options): AdapterOutput;
}

/** Collects diagnostics for an adapter run. */
export class DiagnosticBag {
  readonly items: AdapterDiagnostic[] = [];

  add(severity: AdapterDiagnosticSeverity, code: string, message: string, at: { model?: string; field?: string } = {}): void {
    this.items.push({
      severity,
      code,
      message,
      ...(at.model === undefined ? {} : { model: at.model }),
      ...(at.field === undefined ? {} : { field: at.field }),
    });
  }

  error(code: string, message: string, at?: { model?: string; field?: string }): void {
    this.add('error', code, message, at);
  }

  warning(code: string, message: string, at?: { model?: string; field?: string }): void {
    this.add('warning', code, message, at);
  }

  info(code: string, message: string, at?: { model?: string; field?: string }): void {
    this.add('info', code, message, at);
  }
}

/** Formats a diagnostic as one line: `warning[CODE] Model.field: message`. */
export function formatDiagnostic(d: AdapterDiagnostic): string {
  const location = d.model === undefined ? '' : ` ${d.model}${d.field === undefined ? '' : `.${d.field}`}`;
  return `${d.severity}[${d.code}]${location}: ${d.message}`;
}

/** Finds the relation a relation field belongs to (relation names are only unique per model pair). */
export function findRelation(ir: IrSchema, model: string, field: string): IrRelation | undefined {
  return ir.relations.find((r) => {
    const [x, y] = r.kind === 'many-to-many' ? [r.a, r.b] : [r.from, r.to];
    return (x.model === model && x.field === field) || (y.model === model && y.field === field);
  });
}
