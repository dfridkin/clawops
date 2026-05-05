// Provider error types — part of the error taxonomy (spec/errors.yaml).

export class ProviderError extends Error {
  constructor(
    public readonly provider: string,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(`[${provider}] ${message}`)
    this.name = 'ProviderError'
  }
}

export class CredentialError extends ProviderError {
  constructor(provider: string, message: string) {
    super(provider, message)
    this.name = 'CredentialError'
  }
}

export class ProvisionError extends ProviderError {
  constructor(provider: string, message: string, cause?: unknown) {
    super(provider, message, cause)
    this.name = 'ProvisionError'
  }
}
