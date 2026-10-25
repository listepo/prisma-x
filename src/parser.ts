import { stripVTControlCharacters } from 'node:util';
import { buildAst, type Datasource, type SchemaAst } from './ast.js';
import type { Dmmf, DmmfDatamodel } from './dmmf.js';
import { SchemaError, type Diagnostic } from './errors.js';
import {
  wasmGetConfig,
  wasmGetDatamodel,
  wasmGetDmmf,
  wasmLint,
  wasmValidate,
  type WasmCallResult,
} from './internal/wasm.js';
import { createSpanMapper } from './spans.js';

export type ParseSuccess<T> = {
  readonly ok: true;
  readonly value: T;
  /** Non-fatal engine diagnostics (e.g. deprecated preview features). */
  readonly warnings: readonly Diagnostic[];
};

export type ParseFailure = {
  readonly ok: false;
  readonly error: SchemaError;
};

export type ParseResult<T> = ParseSuccess<T> | ParseFailure;

/** Thrown internally to short-circuit a pipeline; always converted to a `ParseFailure`. */
class Abort {
  constructor(readonly error: SchemaError) {}
}

interface RawLintDiagnostic {
  readonly file_name: string;
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly is_warning: boolean;
}

function isRawLintDiagnostic(value: unknown): value is RawLintDiagnostic {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['file_name'] === 'string' &&
    typeof v['start'] === 'number' &&
    typeof v['end'] === 'number' &&
    typeof v['text'] === 'string' &&
    typeof v['is_warning'] === 'boolean'
  );
}

function parseJson(output: string, what: string): unknown {
  try {
    return JSON.parse(output) as unknown;
  } catch (cause) {
    throw new Abort(new SchemaError('MALFORMED_OUTPUT', `Engine returned invalid JSON for ${what}`, { cause }));
  }
}

function unwrap(result: WasmCallResult, what: string, spans: () => readonly Diagnostic[]): string {
  if (result.ok) return result.output;
  if (result.kind === 'panic') {
    throw new Abort(new SchemaError('ENGINE_PANIC', `Prisma schema engine panicked during ${what}: ${result.message}`));
  }
  // Engine errors are JSON: { error_code, message }.
  let engineCode: string | undefined;
  let message = result.payload;
  try {
    const parsed = JSON.parse(result.payload) as { error_code?: unknown; message?: unknown };
    if (typeof parsed.error_code === 'string') engineCode = parsed.error_code;
    if (typeof parsed.message === 'string') message = parsed.message;
  } catch {
    // Not JSON; keep the raw text as the message.
  }
  throw new Abort(
    new SchemaError('VALIDATION_FAILED', stripVTControlCharacters(message), { engineCode, spans: spans() }),
  );
}

function lint(source: string): Diagnostic[] {
  const raw = parseJson(unwrap(wasmLint(source), 'lint', () => []), 'lint');
  if (!Array.isArray(raw) || !raw.every(isRawLintDiagnostic)) {
    throw new Abort(new SchemaError('MALFORMED_OUTPUT', 'Engine returned an unexpected lint result'));
  }
  if (raw.length === 0) return [];
  const toSpan = createSpanMapper(source);
  return raw.map((d) => ({
    ...toSpan(d.file_name, d.start, d.end),
    severity: d.is_warning ? 'warning' : 'error',
    message: d.text,
  }));
}

/**
 * Shared pipeline: checks the input, validates it and collects diagnostics,
 * then runs `step` on a valid schema.
 */
function run<T>(source: unknown, step: (source: string) => T): ParseResult<T> {
  try {
    if (typeof source !== 'string') {
      throw new Abort(new SchemaError('INVALID_INPUT', `Expected schema source to be a string, got ${typeof source}`));
    }
    const diagnostics = lint(source);
    const errors = diagnostics.filter((d) => d.severity === 'error');
    unwrap(wasmValidate(source), 'validation', () => errors);
    // The engine treats some lint errors as non-fatal; never drop them silently.
    if (errors.length > 0) {
      throw new Abort(
        new SchemaError('VALIDATION_FAILED', errors.map((e) => e.message).join('\n'), { spans: errors }),
      );
    }
    const value = step(source);
    return { ok: true, value, warnings: diagnostics.filter((d) => d.severity === 'warning') };
  } catch (thrown) {
    if (thrown instanceof Abort) return { ok: false, error: thrown.error };
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    return { ok: false, error: new SchemaError('MALFORMED_OUTPUT', message, { cause: thrown }) };
  }
}

function readDatamodel(value: unknown): DmmfDatamodel {
  const dm = value as Partial<DmmfDatamodel> | null;
  if (typeof dm !== 'object' || dm === null || !Array.isArray(dm.models) || !Array.isArray(dm.enums)) {
    throw new Abort(new SchemaError('MALFORMED_OUTPUT', 'Engine returned an unexpected datamodel'));
  }
  return dm as DmmfDatamodel;
}

function readDatasources(source: string): Datasource[] {
  const config = parseJson(unwrap(wasmGetConfig(source), 'get_config', () => []), 'get_config') as {
    config?: { datasources?: unknown };
    errors?: unknown;
  };
  if (Array.isArray(config.errors) && config.errors.length > 0) {
    const messages = config.errors.map((e: { message?: unknown }) => String(e.message ?? e));
    throw new Abort(new SchemaError('VALIDATION_FAILED', stripVTControlCharacters(messages.join('\n'))));
  }
  const datasources = config.config?.datasources;
  if (!Array.isArray(datasources)) {
    throw new Abort(new SchemaError('MALFORMED_OUTPUT', 'Engine returned an unexpected config'));
  }
  return datasources.map((d: Datasource) => ({
    name: d.name,
    provider: d.provider,
    activeProvider: d.activeProvider,
    schemas: d.schemas,
  }));
}

/** Validates a schema. Succeeds with `undefined` and any warnings. */
export function validate(source: string): ParseResult<undefined> {
  return run(source, () => undefined);
}

/**
 * Returns the full DMMF document (datamodel, query schema, mappings).
 *
 * This is large (tens of MB for hundreds of models). Prefer `parseSchema` when
 * only the datamodel is needed.
 */
export function getDmmf(source: string): ParseResult<Dmmf> {
  return run(source, (valid) => {
    const dmmf = parseJson(unwrap(wasmGetDmmf(valid), 'get_dmmf', () => []), 'get_dmmf') as Partial<Dmmf>;
    return { datamodel: readDatamodel(dmmf.datamodel), schema: dmmf.schema ?? null, mappings: dmmf.mappings ?? null };
  });
}

/** Parses a schema into a typed AST of datasources, models, enums and relations. */
export function parseSchema(source: string): ParseResult<SchemaAst> {
  return run(source, (valid) => {
    const datamodel = readDatamodel(parseJson(unwrap(wasmGetDatamodel(valid), 'get_datamodel', () => []), 'get_datamodel'));
    return buildAst(datamodel, readDatasources(valid), valid);
  });
}
