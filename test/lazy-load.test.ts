import { expect, it } from 'vitest';
import { validate } from '../src/index.js';
import { isWasmLoaded } from '../src/internal/wasm.js';

// Vitest isolates each test file, so this module graph starts fresh.
it('loads the wasm module only on first use', () => {
  expect(isWasmLoaded()).toBe(false);
  expect(validate('').ok).toBe(true);
  expect(isWasmLoaded()).toBe(true);
});
