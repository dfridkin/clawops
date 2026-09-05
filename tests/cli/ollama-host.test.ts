// G23: Ollama on the host is unreachable from the gateway container at `localhost`.
// Never fixed before v1.7.2 — `host.docker.internal` and `--add-host` had never
// appeared in this repo (git log -S across all branches: zero commits).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as yaml from 'js-yaml'
import { rewriteLocalhostForContainer } from '../../src/cli/commands/setup.js'

const ROOT = join(__dirname, '../..')

describe('rewriteLocalhostForContainer', () => {
  it('rewrites the loopback forms a user is likely to type', () => {
    expect(rewriteLocalhostForContainer('http://localhost:11434'))
      .toBe('http://host.docker.internal:11434')
    expect(rewriteLocalhostForContainer('http://127.0.0.1:11434'))
      .toBe('http://host.docker.internal:11434')
    expect(rewriteLocalhostForContainer('https://localhost:11434'))
      .toBe('https://host.docker.internal:11434')
    expect(rewriteLocalhostForContainer('http://[::1]:11434'))
      .toBe('http://host.docker.internal:11434')
  })

  it('is case-insensitive on the host portion', () => {
    expect(rewriteLocalhostForContainer('http://LOCALHOST:11434'))
      .toBe('http://host.docker.internal:11434')
  })

  it('preserves a path', () => {
    expect(rewriteLocalhostForContainer('http://localhost:11434/v1'))
      .toBe('http://host.docker.internal:11434/v1')
  })

  it('leaves real hosts alone', () => {
    for (const url of [
      'http://ollama.internal:11434',
      'http://10.0.0.5:11434',
      'http://host.docker.internal:11434',
    ]) {
      expect(rewriteLocalhostForContainer(url)).toBe(url)
    }
  })

  it('does not rewrite a hostname that merely starts with localhost', () => {
    expect(rewriteLocalhostForContainer('http://localhost.example.com:11434'))
      .toBe('http://localhost.example.com:11434')
  })
})

describe('spec/models.yaml', () => {
  const catalog = yaml.load(
    readFileSync(join(ROOT, 'spec/models.yaml'), 'utf-8'),
  ) as { providers: Array<{ id: string; baseUrlDefault?: string; postSetupNote?: string }> }

  const ollama = catalog.providers.find((p) => p.id === 'ollama')

  it('defaults Ollama to an address the container can actually reach', () => {
    expect(ollama?.baseUrlDefault).toBe('http://host.docker.internal:11434')
    expect(ollama?.baseUrlDefault).not.toContain('localhost')
  })

  it('tells the operator to bind Ollama where the container can see it', () => {
    // A host-side Ollama on 127.0.0.1 stays unreachable even with the alias.
    expect(ollama?.postSetupNote).toContain('OLLAMA_HOST=0.0.0.0')
  })
})
