import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as api from '../src/index.js';

describe('public API', () => {
  it('exports only the wrapper runtime values', () => {
    expect(Object.keys(api).sort()).toEqual(['SchemaError', 'getDmmf', 'parseSchema', 'validate']);
  });

  it('never re-exports the wasm package from src/index.ts', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/prisma-schema-wasm|internal\//);
  });

  it('does not export any wasm function', () => {
    for (const name of ['get_dmmf', 'get_datamodel', 'lint', 'format', 'get_config', 'DmmfBuffer']) {
      expect(api).not.toHaveProperty(name);
    }
  });
});
