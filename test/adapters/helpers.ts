import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import {
  buildIr,
  formatDiagnostic,
  parseSchema,
  type Adapter,
  type AdapterDiagnostic,
  type AdapterOptions,
  type AdapterOutput,
  type IrSchema,
} from '../../src/index.js';
import { expectOk } from '../helpers.js';

const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));

export interface Fixture {
  readonly name: string;
  readonly source: string;
}

/** Every `test/fixtures/*.prisma`, sorted by name. */
export const fixtures: readonly Fixture[] = readdirSync(FIXTURES)
  .filter((file) => file.endsWith('.prisma'))
  .sort()
  .map((file) => ({ name: basename(file, '.prisma'), source: readFileSync(join(FIXTURES, file), 'utf8') }));

export function fixture(name: string): Fixture {
  const found = fixtures.find((f) => f.name === name);
  if (found === undefined) throw new Error(`no fixture ${name}`);
  return found;
}

export const irOf = (source: string): IrSchema => buildIr(expectOk(parseSchema(source)));

export function run<O extends AdapterOptions>(adapter: Adapter<O>, source: string, options?: O): AdapterOutput {
  return adapter.generate(irOf(source), options);
}

export function file(output: AdapterOutput, path: string): string {
  const found = output.files.find((f) => f.path === path);
  if (found === undefined) expect.fail(`no generated file ${path}; got ${output.files.map((f) => f.path).join(', ')}`);
  return found.contents;
}

export const codes = (diagnostics: readonly AdapterDiagnostic[]): string[] => diagnostics.map((d) => `${d.severity}:${d.code}`);

export function diagnosticsText(diagnostics: readonly AdapterDiagnostic[]): string {
  return diagnostics.length === 0 ? '(no diagnostics)\n' : `${diagnostics.map(formatDiagnostic).join('\n')}\n`;
}
