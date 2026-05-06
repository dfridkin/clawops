// Unit tests for the clawops error taxonomy.

import { describe, it, expect } from 'vitest'
import {
  ClawopsError,
  UsageError,
  AuthError,
  StateError,
  ProviderError,
  NetworkError,
  OperationalError,
  CancelledError,
} from '../../src/errors/index.js'

describe('ClawopsError base class', () => {
  it('sets message, errorClass, exitCode, retryable, name', () => {
    const err = new ClawopsError('oops', 'TestError', 99, true)
    expect(err.message).toBe('oops')
    expect(err.errorClass).toBe('TestError')
    expect(err.exitCode).toBe(99)
    expect(err.retryable).toBe(true)
    expect(err).toBeInstanceOf(Error)
  })
})

describe('UsageError', () => {
  it('has exitCode 2 and retryable false', () => {
    const err = new UsageError('bad args')
    expect(err.exitCode).toBe(2)
    expect(err.retryable).toBe(false)
    expect(err.errorClass).toBe('UsageError')
    expect(err.name).toBe('UsageError')
    expect(err.message).toBe('bad args')
  })
})

describe('AuthError', () => {
  it('has exitCode 3 and retryable false', () => {
    const err = new AuthError('no creds')
    expect(err.exitCode).toBe(3)
    expect(err.retryable).toBe(false)
    expect(err.errorClass).toBe('AuthError')
  })
})

describe('StateError', () => {
  it('has exitCode 4 and retryable false', () => {
    const err = new StateError('corrupt state')
    expect(err.exitCode).toBe(4)
    expect(err.retryable).toBe(false)
    expect(err.errorClass).toBe('StateError')
  })
})

describe('ProviderError', () => {
  it('has exitCode 5 and default retryable false', () => {
    const err = new ProviderError('rate limited')
    expect(err.exitCode).toBe(5)
    expect(err.retryable).toBe(false)
    expect(err.errorClass).toBe('ProviderError')
  })

  it('accepts retryable=true', () => {
    const err = new ProviderError('transient', true)
    expect(err.retryable).toBe(true)
  })
})

describe('NetworkError', () => {
  it('has exitCode 6 and retryable true', () => {
    const err = new NetworkError('timeout')
    expect(err.exitCode).toBe(6)
    expect(err.retryable).toBe(true)
    expect(err.errorClass).toBe('NetworkError')
  })
})

describe('OperationalError', () => {
  it('has exitCode 1 and default retryable false', () => {
    const err = new OperationalError('unexpected failure')
    expect(err.exitCode).toBe(1)
    expect(err.retryable).toBe(false)
    expect(err.errorClass).toBe('OperationalError')
  })

  it('accepts retryable=true', () => {
    const err = new OperationalError('flaky op', true)
    expect(err.retryable).toBe(true)
  })
})

describe('CancelledError', () => {
  it('uses default message "Operation cancelled"', () => {
    const err = new CancelledError()
    expect(err.message).toBe('Operation cancelled')
    expect(err.exitCode).toBe(130)
    expect(err.retryable).toBe(true)
    expect(err.errorClass).toBe('CancelledError')
  })

  it('accepts a custom message', () => {
    const err = new CancelledError('user hit Ctrl+C')
    expect(err.message).toBe('user hit Ctrl+C')
  })
})
