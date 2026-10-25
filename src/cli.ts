#!/usr/bin/env node
/**
 * `prismax` command line.
 *
 *   prismax generate --adapter <name> --schema <file> --out <dir> [--provider <p>] [--dry-run]
 *
 * Exit codes: 0 success, 1 schema/adapter errors or I/O failure, 2 usage error.
 */
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { adapters } from './adapters/index.js';
import { formatDiagnostic } from './core/adapter.js';
import type { Diagnostic } from './errors.js';
import { generate } from './generate.js';

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly cwd: string;
}

const USAGE = `Usage: prismax generate --adapter <${Object.keys(adapters).join('|')}> --schema <file> --out <dir> [options]

Options:
  --adapter <name>     output target
  --schema <file>      Prisma schema file
  --out <dir>          output directory (created if missing)
  --provider <name>    override the datasource provider (postgresql, mysql, sqlite, ...)
  --dry-run            print the generated files to stdout instead of writing them
  -h, --help           show this help
`;

class UsageError extends Error {}

function formatSpan(path: string, d: Diagnostic): string {
  return `${path}:${d.startPosition.line}:${d.startPosition.column}: ${d.severity}: ${d.message}`;
}

function runGenerate(args: string[], io: CliIo): number {
  const { values } = parseArgs({
    args,
    options: {
      adapter: { type: 'string' },
      schema: { type: 'string' },
      out: { type: 'string' },
      provider: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.adapter === undefined) throw new UsageError('missing --adapter');
  const adapter = Object.hasOwn(adapters, values.adapter) ? adapters[values.adapter] : undefined;
  if (adapter === undefined) {
    throw new UsageError(`unknown adapter "${values.adapter}" (available: ${Object.keys(adapters).join(', ')})`);
  }
  if (values.schema === undefined) throw new UsageError('missing --schema');
  const dryRun = values['dry-run'] === true;
  if (values.out === undefined && !dryRun) throw new UsageError('missing --out (or pass --dry-run)');

  const schemaPath = resolve(io.cwd, values.schema);
  let source: string;
  try {
    source = readFileSync(schemaPath, 'utf8');
  } catch (error) {
    io.stderr(`error: cannot read schema ${values.schema}: ${(error as Error).message}\n`);
    return 1;
  }

  const result = generate(source, adapter, values.provider === undefined ? {} : { provider: values.provider });
  if (!result.ok) {
    const { error } = result;
    const code = error.engineCode === undefined ? error.code : `${error.code} ${error.engineCode}`;
    if (error.spans.length > 0) {
      for (const span of error.spans) io.stderr(`${formatSpan(values.schema, span)}\n`);
      io.stderr(`error[${code}]: schema is invalid\n`);
    } else {
      io.stderr(`error[${code}]: ${error.message}\n`);
    }
    return 1;
  }

  for (const warning of result.warnings) io.stderr(`${formatSpan(values.schema, warning)}\n`);
  for (const diagnostic of result.value.diagnostics) io.stderr(`${formatDiagnostic(diagnostic)}\n`);

  if (dryRun) {
    for (const file of result.value.files) io.stdout(`==> ${file.path} <==\n${file.contents}\n`);
  } else {
    const outDir = resolve(io.cwd, values.out ?? '.');
    for (const file of result.value.files) {
      const target = resolve(outDir, file.path);
      const rel = relative(outDir, target);
      if (rel.startsWith('..') || isAbsolute(rel)) {
        io.stderr(`error: adapter produced a path outside the output directory: ${file.path}\n`);
        return 1;
      }
      try {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, file.contents);
      } catch (error) {
        io.stderr(`error: cannot write ${target}: ${(error as Error).message}\n`);
        return 1;
      }
      io.stdout(`wrote ${relative(io.cwd, target) || target}\n`);
    }
  }
  return result.value.diagnostics.some((d) => d.severity === 'error') ? 1 : 0;
}

/** Runs the CLI with `args` (without `node` and the script path). Returns the exit code. */
export function runCli(args: readonly string[], io: CliIo): number {
  const [command, ...rest] = args;
  try {
    if (command === undefined || command === '-h' || command === '--help' || command === 'help') {
      (command === undefined ? io.stderr : io.stdout)(USAGE);
      return command === undefined ? 2 : 0;
    }
    if (command !== 'generate') throw new UsageError(`unknown command "${command}"`);
    if (rest.includes('-h') || rest.includes('--help')) {
      io.stdout(USAGE);
      return 0;
    }
    return runGenerate(rest, io);
  } catch (error) {
    // parseArgs reports unknown or malformed options as TypeErrors with a code.
    if (error instanceof UsageError || (error as { code?: unknown }).code?.toString().startsWith('ERR_PARSE_ARGS')) {
      io.stderr(`error: ${(error as Error).message}\n\n${USAGE}`);
      return 2;
    }
    throw error;
  }
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  process.exitCode = runCli(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    cwd: process.cwd(),
  });
}
