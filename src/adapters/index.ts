/** Built-in adapters by name, as used by the CLI. */
import type { Adapter } from '../core/adapter.js';
import { dieselAdapter } from './diesel/index.js';
import { sqlalchemyAdapter } from './sqlalchemy/index.js';

export const adapters: Readonly<Record<string, Adapter>> = {
  diesel: dieselAdapter,
  sqlalchemy: sqlalchemyAdapter,
};
