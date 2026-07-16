/**
 * Compile-time exhaustiveness guard. Use as the `default` arm of a `switch`
 * over a union: if a new union member is added, the call no longer typechecks
 * until every switch handles it. The throw is unreachable unless the type
 * system was bypassed at runtime.
 */
export function assertNever(value: never): never {
  throw new Error(`Unhandled variant: ${String(value)}`);
}
