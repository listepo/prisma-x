import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';

const blog = `datasource db {
  provider = "postgresql"
}

model User {
  id    Int    @id @default(autoincrement())
  email String @unique
}
`;

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'prismax-cli-'));
  writeFileSync(join(cwd, 'schema.prisma'), blog);
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function cli(...args: string[]) {
  let stdout = '';
  let stderr = '';
  const code = runCli(args, { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t), cwd });
  return { code, stdout, stderr };
}

describe('prismax CLI', () => {
  it('prints help', () => {
    const help = cli('--help');
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('Usage: prismax generate --adapter <diesel|sqlalchemy>');
    expect(cli('generate', '--help')).toMatchObject({ code: 0, stdout: expect.stringContaining('--dry-run') });
  });

  it('exits with 2 on usage errors', () => {
    expect(cli()).toMatchObject({ code: 2, stderr: expect.stringContaining('Usage:') });
    expect(cli('build')).toMatchObject({ code: 2, stderr: expect.stringContaining('unknown command "build"') });
    expect(cli('generate', '--schema', 'schema.prisma', '--out', 'out')).toMatchObject({
      code: 2,
      stderr: expect.stringContaining('missing --adapter'),
    });
    expect(cli('generate', '--adapter', 'prisma', '--schema', 'schema.prisma', '--out', 'out')).toMatchObject({
      code: 2,
      stderr: expect.stringContaining('unknown adapter "prisma" (available: diesel, sqlalchemy)'),
    });
    expect(cli('generate', '--adapter', 'toString', '--schema', 'schema.prisma', '--dry-run').code).toBe(2);
    expect(cli('generate', '--adapter', 'diesel', '--out', 'out').stderr).toContain('missing --schema');
    expect(cli('generate', '--adapter', 'diesel', '--schema', 'schema.prisma').stderr).toContain('missing --out');
    expect(cli('generate', '--adapter', 'diesel', '--schema', 'schema.prisma', '--dry-run', '--force')).toMatchObject({
      code: 2,
      stderr: expect.stringContaining("Unknown option '--force'"),
    });
    expect(existsSync(join(cwd, 'out'))).toBe(false);
  });

  it('writes the generated files', () => {
    const result = cli('generate', '--adapter', 'diesel', '--schema', 'schema.prisma', '--out', 'gen/rust');
    expect(result).toEqual({ code: 0, stdout: `wrote ${join('gen', 'rust', 'schema.rs')}\nwrote ${join('gen', 'rust', 'models.rs')}\n`, stderr: '' });
    expect(readFileSync(join(cwd, 'gen', 'rust', 'schema.rs'), 'utf8')).toContain('diesel::table! {');
    expect(cli('generate', '--adapter', 'sqlalchemy', '--schema', 'schema.prisma', '--out', 'py').code).toBe(0);
    expect(readFileSync(join(cwd, 'py', 'models.py'), 'utf8')).toContain('class User(Base):');
  });

  it('prints files instead of writing them with --dry-run', () => {
    const result = cli('generate', '--adapter', 'sqlalchemy', '--schema', 'schema.prisma', '--out', 'py', '--dry-run');
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^==> models\.py <==\n# @generated/);
    expect(existsSync(join(cwd, 'py'))).toBe(false);
  });

  it('reports schema errors with file positions and exits with 1', () => {
    writeFileSync(join(cwd, 'broken.prisma'), 'model User {\n  id Int @id\n  posts Post[]\n}\n');
    const result = cli('generate', '--adapter', 'diesel', '--schema', 'broken.prisma', '--out', 'out');
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/^broken\.prisma:3:\d+: error: Type "Post" is neither a built-in type/m);
    expect(result.stderr).toContain('schema is invalid');
    expect(result.stdout).toBe('');
    expect(existsSync(join(cwd, 'out'))).toBe(false);
  });

  it('exits with 1 when the schema cannot be read', () => {
    const result = cli('generate', '--adapter', 'diesel', '--schema', 'missing.prisma', '--dry-run');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('error: cannot read schema missing.prisma');
  });

  it('prints adapter diagnostics to stderr and keeps going on warnings', () => {
    writeFileSync(
      join(cwd, 'warn.prisma'),
      'datasource db {\n  provider = "postgresql"\n}\n\nmodel Place {\n  id  Int @id\n  loc Unsupported("point")?\n}\n',
    );
    const result = cli('generate', '--adapter', 'diesel', '--schema', 'warn.prisma', '--dry-run');
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('warning[UNSUPPORTED_FIELD] Place.loc: Unsupported("point") has no Diesel type; column "loc" is omitted\n');
    expect(result.stdout).toContain('==> schema.rs <==');
  });

  it('exits with 1 on adapter errors', () => {
    writeFileSync(join(cwd, 'mongo.prisma'), 'datasource db {\n  provider = "mongodb"\n}\n\nmodel A {\n  id String @id @map("_id")\n}\n');
    const result = cli('generate', '--adapter', 'diesel', '--schema', 'mongo.prisma', '--out', 'out');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('error[UNSUPPORTED_PROVIDER]');
  });

  it('overrides the provider', () => {
    writeFileSync(join(cwd, 'plain.prisma'), 'model A {\n  id Int @id\n}\n');
    expect(cli('generate', '--adapter', 'diesel', '--schema', 'plain.prisma', '--dry-run').stderr).toContain('MISSING_PROVIDER');
    const result = cli('generate', '--adapter', 'diesel', '--schema', 'plain.prisma', '--provider', 'sqlite', '--dry-run');
    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(result.stdout).toContain('check_for_backend(diesel::sqlite::Sqlite)');
    expect(cli('generate', '--adapter', 'diesel', '--schema', 'plain.prisma', '--provider', 'constructor', '--dry-run')).toMatchObject({
      code: 1,
      stderr: expect.stringContaining('error[UNSUPPORTED_PROVIDER]'),
    });
    expect(cli('generate', '--adapter', 'sqlalchemy', '--schema', 'plain.prisma', '--provider', 'constructor', '--dry-run')).toMatchObject({
      code: 0,
      stderr: expect.stringContaining('info[GENERIC_DIALECT]'),
    });
  });
});
