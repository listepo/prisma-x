/** 1-based line and column. Columns count UTF-16 code units, like JS strings. */
export interface Position {
  readonly line: number;
  readonly column: number;
}

/** A region of the schema source. */
export interface SourceSpan {
  readonly fileName: string;
  /** UTF-16 offsets, usable with `source.slice(start, end)`. */
  readonly start: number;
  readonly end: number;
  readonly startPosition: Position;
  readonly endPosition: Position;
}

export type Severity = 'error' | 'warning';

/** A single engine diagnostic attached to a source span. */
export interface Diagnostic extends SourceSpan {
  readonly severity: Severity;
  readonly message: string;
}

export type SchemaErrorCode =
  /** The input was not a string. */
  | 'INVALID_INPUT'
  /** The schema failed Prisma validation (syntax or semantic errors). */
  | 'VALIDATION_FAILED'
  /** The wasm engine panicked (a bug in the engine, not in the schema). */
  | 'ENGINE_PANIC'
  /** The engine returned output this library could not interpret. */
  | 'MALFORMED_OUTPUT';

export interface SchemaErrorOptions {
  readonly engineCode?: string | undefined;
  readonly spans?: readonly Diagnostic[] | undefined;
  readonly cause?: unknown;
}

export class SchemaError extends Error {
  override readonly name = 'SchemaError';
  readonly code: SchemaErrorCode;
  /** Prisma error code when the engine supplied one, e.g. `P1012`. */
  readonly engineCode: string | undefined;
  /** Error diagnostics with source locations. May be empty. */
  readonly spans: readonly Diagnostic[];

  constructor(code: SchemaErrorCode, message: string, options: SchemaErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.engineCode = options.engineCode;
    this.spans = options.spans ?? [];
  }
}
