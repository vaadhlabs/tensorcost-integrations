// Where the admit protocol's files sit inside this package, for tools and
// tests that read them. The package has no dependencies and reads nothing
// until asked.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Absolute path of openapi.yaml, the machine-readable contract. */
export const specPath = fileURLToPath(new URL('./openapi.yaml', import.meta.url));

/** Absolute path of README.md, the protocol as prose. */
export const readmePath = fileURLToPath(new URL('./README.md', import.meta.url));

/** Absolute path of the examples directory. */
export const examplesDir = fileURLToPath(new URL('./examples/', import.meta.url));

/** openapi.yaml as text. */
export function readSpec() {
  return fs.readFileSync(specPath, 'utf8');
}

/** examples/tensorcost-rows.json: one format=tensorcost row per integration, keyed by integration. */
export function exampleRows() {
  return JSON.parse(fs.readFileSync(new URL('./examples/tensorcost-rows.json', import.meta.url), 'utf8')).rows;
}
