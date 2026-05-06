// Clawops error taxonomy — mirrors spec/errors.yaml exit codes.
// All thrown errors must extend ClawopsError and carry an exitCode.

export class ClawopsError extends Error {
  constructor(
    message: string,
    public readonly errorClass: string,
    public readonly exitCode: number,
    public readonly retryable: boolean = false,
  ) {
    super(message)
    this.name = this.constructor.name
    if (Error.captureStackTrace) Error.captureStackTrace(this, this.constructor)
  }
}

/** Exit 2 — invalid user input; user must change their command. */
export class UsageError extends ClawopsError {
  constructor(message: string) {
    super(message, 'UsageError', 2, false)
  }
}

/** Exit 3 — credentials missing, invalid, or insufficient. */
export class AuthError extends ClawopsError {
  constructor(message: string) {
    super(message, 'AuthError', 3, false)
  }
}

/** Exit 4 — clawops-managed state is corrupt or inconsistent. */
export class StateError extends ClawopsError {
  constructor(message: string) {
    super(message, 'StateError', 4, false)
  }
}

/** Exit 5 — cloud provider rejected the request (non-auth). */
export class ProviderError extends ClawopsError {
  constructor(message: string, retryable = false) {
    super(message, 'ProviderError', 5, retryable)
  }
}

/** Exit 6 — network connectivity failure. */
export class NetworkError extends ClawopsError {
  constructor(message: string) {
    super(message, 'NetworkError', 6, true)
  }
}

/** Exit 1 — unexpected error during a valid operation. */
export class OperationalError extends ClawopsError {
  constructor(message: string, retryable = false) {
    super(message, 'OperationalError', 1, retryable)
  }
}

/** Exit 130 — user-initiated cancellation (SIGINT). */
export class CancelledError extends ClawopsError {
  constructor(message = 'Operation cancelled') {
    super(message, 'CancelledError', 130, true)
  }
}
