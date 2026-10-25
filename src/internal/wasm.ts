/**
 * Internal bridge to `@prisma/prisma-schema-wasm`.
 *
 * This is the only module that touches the wasm package. Nothing here is part
 * of the public API: callers get plain strings back, or a classified failure.
 */
import { createRequire } from 'node:module';

type WasmModule = typeof import('@prisma/prisma-schema-wasm');

/** Shape of the global hook the wasm panic handler writes into. */
interface PanicRegistry {
  set_message(message: string): void;
}

type RegistryHost = { PRISMA_WASM_PANIC_REGISTRY?: PanicRegistry };

/** Outcome of a single wasm call, before it is mapped to a public error. */
export type WasmCallResult =
  | { readonly ok: true; readonly output: string }
  /** The engine rejected the input and threw its JSON error payload. */
  | { readonly ok: false; readonly kind: 'engine-error'; readonly payload: string }
  /** The wasm module trapped (Rust panic). `message` is the panic text if captured. */
  | { readonly ok: false; readonly kind: 'panic'; readonly message: string };

let wasm: WasmModule | undefined;
let lastPanicMessage: string | undefined;

/**
 * The wasm panic hook calls `globalThis.PRISMA_WASM_PANIC_REGISTRY.set_message`
 * and crashes with a TypeError if it is missing. Install ours, chaining to any
 * registry another library (e.g. Prisma itself) has already set up.
 */
function installPanicRegistry(): void {
  const host = globalThis as RegistryHost;
  const previous = host.PRISMA_WASM_PANIC_REGISTRY;
  host.PRISMA_WASM_PANIC_REGISTRY = {
    set_message(message: string) {
      lastPanicMessage = message;
      previous?.set_message(message);
    },
  };
}

/** Loads the wasm module on first use, so importing this library is free. */
function load(): WasmModule {
  if (wasm === undefined) {
    installPanicRegistry();
    const require = createRequire(import.meta.url);
    wasm = require('@prisma/prisma-schema-wasm') as WasmModule;
  }
  return wasm;
}

/** Whether the wasm module has been instantiated in this process. */
export function isWasmLoaded(): boolean {
  return wasm !== undefined;
}

function call(fn: (mod: WasmModule) => string): WasmCallResult {
  const mod = load();
  lastPanicMessage = undefined;
  try {
    return { ok: true, output: fn(mod) };
  } catch (thrown) {
    // A trap surfaces as WebAssembly.RuntimeError; engine errors are plain Errors.
    if (thrown instanceof Error && thrown.name === 'RuntimeError') {
      return { ok: false, kind: 'panic', message: lastPanicMessage ?? thrown.message };
    }
    const payload = thrown instanceof Error ? thrown.message : String(thrown);
    return { ok: false, kind: 'engine-error', payload };
  }
}

function schemaParams(schema: string): string {
  return JSON.stringify({ prismaSchema: schema, noColor: true });
}

export function wasmValidate(schema: string): WasmCallResult {
  return call((mod) => {
    mod.validate(schemaParams(schema));
    return '';
  });
}

export function wasmLint(schema: string): WasmCallResult {
  return call((mod) => mod.lint(JSON.stringify(schema)));
}

export function wasmGetDatamodel(schema: string): WasmCallResult {
  return call((mod) => mod.get_datamodel(schemaParams(schema)));
}

export function wasmGetDmmf(schema: string): WasmCallResult {
  return call((mod) => mod.get_dmmf(schemaParams(schema)));
}

export function wasmGetConfig(schema: string): WasmCallResult {
  return call((mod) =>
    mod.get_config(
      JSON.stringify({ prismaSchema: schema, datasourceOverrides: {}, ignoreEnvVarErrors: true, env: {} }),
    ),
  );
}
