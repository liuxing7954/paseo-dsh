/**
 * Structural JSON value used by Paseo's provider contract.
 *
 * Kept local on purpose: `@getpaseo/protocol` is a Paseo-internal package that
 * the plugin installer does not provide, and that installer resolves every
 * type-only import from the plugin directory. Importing `JsonValue` from
 * `@getpaseo/protocol/agent-types` therefore makes `paseo plugin add` fail with
 * `Could not resolve type dependency`, even though the import is erased at
 * runtime. The shape below is identical to the one Paseo declares, so the two stay
 * structurally compatible without the dependency.
 *
 * @module dsh-paseo/server/json-value
 */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
