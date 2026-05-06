// Result<T, E> — explicit success/failure without exceptions.
// Adapters return Results; only the CLI boundary throws.

export type Result<T, E = Error> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E }

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value }
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error }
}

/** Unwrap a Result, throwing the error if not ok. */
export function unwrap<T, E extends Error>(result: Result<T, E>): T {
  if (result.ok) return result.value
  throw result.error
}
