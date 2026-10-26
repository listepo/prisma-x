import { buildIr } from './core/build.js';
import type { Adapter, AdapterOptions, AdapterOutput } from './core/adapter.js';
import { parseSchema, type ParseResult } from './parser.js';

/**
 * Parses a schema, builds the IR and runs an adapter on it.
 *
 * Schema errors come back as a failed result; unsupported features come back
 * as adapter diagnostics on a successful one.
 */
export function generate<Options extends AdapterOptions>(
  source: string,
  adapter: Adapter<Options>,
  options?: Options,
): ParseResult<AdapterOutput> {
  const parsed = parseSchema(source);
  if (!parsed.ok) return parsed;
  return { ok: true, value: adapter.generate(buildIr(parsed.value), options), warnings: parsed.warnings };
}
