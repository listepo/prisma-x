import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as diesel from '../src/adapters/diesel/index.js';
import * as sqlalchemy from '../src/adapters/sqlalchemy/index.js';
import * as api from '../src/index.js';

describe('public API', () => {
  it('exports exactly the documented runtime values', () => {
    expect(Object.keys(api).sort()).toEqual([
      'DiagnosticBag',
      'SchemaError',
      'buildIr',
      'findRelation',
      'formatDiagnostic',
      'generate',
      'getDmmf',
      'parseSchema',
      'splitWords',
      'toCamelCase',
      'toPascalCase',
      'toSnakeCase',
      'validate',
    ]);
  });

  it('exports one adapter from each adapter entry point', () => {
    expect(Object.keys(diesel)).toEqual(['dieselAdapter']);
    expect(Object.keys(sqlalchemy)).toEqual(['sqlalchemyAdapter']);
  });

  it('never re-exports the wasm package from public entry points', () => {
    for (const path of ['../src/index.ts', '../src/core/index.ts', '../src/adapters/diesel/index.ts', '../src/adapters/sqlalchemy/index.ts']) {
      const source = readFileSync(new URL(path, import.meta.url), 'utf8');
      expect(source).not.toMatch(/prisma-schema-wasm|internal\//);
    }
  });

  it('keeps the core free of adapter imports', () => {
    for (const file of ['adapter.ts', 'build.ts', 'index.ts', 'ir.ts', 'names.ts']) {
      const source = readFileSync(new URL(`../src/core/${file}`, import.meta.url), 'utf8');
      expect(source).not.toMatch(/adapters\//);
    }
  });

  it('does not export any wasm function', () => {
    for (const name of ['get_dmmf', 'get_datamodel', 'lint', 'format', 'get_config', 'DmmfBuffer']) {
      expect(api).not.toHaveProperty(name);
    }
  });
});
