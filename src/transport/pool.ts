// SshConnectionPool — reuse SSH connections within a process lifetime.
// Keyed by {host, port, user}; 5-minute idle TTL; max 4 connections per host.
// See src/transport/CLAUDE.md for configuration details.

import { connect, type SshConnectOpts, type SshSession } from './ssh.js'
import { NetworkError } from '../errors/index.js'

const IDLE_TTL_MS = 5 * 60 * 1_000 // 5 minutes
const MAX_PER_HOST = 4
const CLEANUP_INTERVAL_MS = 30_000 // check every 30s

interface PoolEntry {
  session: SshSession
  hostKey: string
  lastUsed: number
  inUse: boolean
}

const pool = new Map<string, PoolEntry[]>()
let cleanupTimer: ReturnType<typeof setInterval> | null = null

function poolKey(opts: Pick<SshConnectOpts, 'host' | 'port' | 'user'>): string {
  return `${opts.user}@${opts.host}:${opts.port}`
}

function startCleanupTimer(): void {
  if (cleanupTimer) return
  cleanupTimer = setInterval(() => {
    const now = Date.now()
    for (const [key, entries] of pool) {
      const active = entries.filter((e) => {
        if (!e.inUse && now - e.lastUsed > IDLE_TTL_MS) {
          e.session.close()
          return false
        }
        return true
      })
      if (active.length === 0) {
        pool.delete(key)
      } else {
        pool.set(key, active)
      }
    }
    if (pool.size === 0 && cleanupTimer) {
      clearInterval(cleanupTimer)
      cleanupTimer = null
    }
  }, CLEANUP_INTERVAL_MS)
  // Don't block Node.js process exit
  cleanupTimer.unref()
}

/**
 * Acquire an SSH session from the pool, creating a new connection if needed.
 * Call `release()` when done to return the session for reuse.
 */
export async function acquireSession(
  opts: SshConnectOpts,
): Promise<{ session: SshSession; release(): void }> {
  const key = poolKey(opts)
  const entries = pool.get(key) ?? []

  // Return an idle connection if available
  const idle = entries.find((e) => !e.inUse)
  if (idle) {
    idle.inUse = true
    idle.lastUsed = Date.now()
    return {
      session: idle.session,
      release() {
        idle.inUse = false
        idle.lastUsed = Date.now()
      },
    }
  }

  // Enforce per-host connection limit
  if (entries.length >= MAX_PER_HOST) {
    throw new NetworkError(
      `SSH connection pool exhausted for ${key} (max ${MAX_PER_HOST} concurrent connections).`,
    )
  }

  // Open a new connection
  const session = await connect(opts)
  const entry: PoolEntry = { session, hostKey: key, lastUsed: Date.now(), inUse: true }
  entries.push(entry)
  pool.set(key, entries)
  startCleanupTimer()

  return {
    session,
    release() {
      entry.inUse = false
      entry.lastUsed = Date.now()
    },
  }
}

/** Close all pooled connections and stop the cleanup timer. */
export function drainPool(): void {
  for (const entries of pool.values()) {
    for (const e of entries) {
      e.session.close()
    }
  }
  pool.clear()
  if (cleanupTimer) {
    clearInterval(cleanupTimer)
    cleanupTimer = null
  }
}
