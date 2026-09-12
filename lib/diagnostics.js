import { appendFile, chmod, mkdir, rename, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'

// Never accept headers, bodies, query strings, or free-form error messages.
const FIELDS = new Set([
  'id', 'method', 'path', 'peer', 'status', 'upstreamStatus', 'durationMs',
  'upstreamMs', 'slow', 'side', 'code', 'reason', 'activeHttp', 'activeWs',
  'clientBytes', 'upstreamBytes', 'idleMs', 'eventLoopLagMs', 'dropped',
  'port', 'targetPort', 'diagEnabled', 'handshakeTimeoutMs',
])

export function diagnosticPath(url) {
  try {
    const path = new URL(url, 'http://gateway.invalid').pathname
    if (path === '/' || path === '/index.html' || path === '/api') return path
    if (/^\/(api|mod-gateway)\/[a-zA-Z][\w.-]{0,63}(\/[a-zA-Z][\w.-]{0,63})?$/.test(path)) return path
    // Asset/file paths can contain user filenames; keep only their category.
    return path.startsWith('/plugins/') ? '/plugins/*' : '/other'
  } catch { return '/invalid' }
}

export function diagnosticError(error) {
  return typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code)
    ? error.code : 'UNKNOWN'
}

/** Bounded, serialized asynchronous JSONL writer. Logging failures never break traffic. */
export function createDiagnostics(path, { maxBytes = 5 * 1024 * 1024, maxFiles = 3, maxPending = 1024, onError = () => {} } = {}) {
  const run = randomBytes(6).toString('hex')
  let queue = [], worker, size = 0, initialized = false, dropped = 0, retryAt = 0
  const line = (event, fields) => JSON.stringify({
    time: new Date().toISOString(), run, event,
    ...Object.fromEntries(Object.entries(fields).filter(([key, value]) => FIELDS.has(key)
      && (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) || typeof value === 'string'))
      .map(([key, value]) => [key, typeof value === 'string' ? value.slice(0, 160) : value])),
  }) + '\n'
  async function drain() {
    try {
      if (!initialized) {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 })
        try { size = (await stat(path)).size; await chmod(path, 0o600) }
        catch (error) { if (error.code !== 'ENOENT') throw error }
        initialized = true
      }
      while (queue.length || dropped) {
        if (dropped) { queue.push(line('log.dropped', { dropped })); dropped = 0 }
        const entry = queue.shift()
        const bytes = Buffer.byteLength(entry)
        if (size > 0 && size + bytes > maxBytes) {
          for (let i = maxFiles - 1; i >= 1; i--) {
            try { await rename(i === 1 ? path : `${path}.${i - 1}`, `${path}.${i}`) }
            catch (error) { if (error.code !== 'ENOENT') throw error }
          }
          size = 0
        }
        await appendFile(path, entry, { mode: 0o600 })
        size += bytes
      }
    } catch (error) {
      queue = []; dropped = 0; initialized = false; retryAt = Date.now() + 30_000
      try { onError(diagnosticError(error)) } catch { /* isolate diagnostic sinks */ }
    }
  }
  function start() {
    worker = drain().finally(() => {
      worker = undefined
      if (queue.length) start()
    })
  }
  return {
    path,
    record(event, fields = {}) {
      if (!path || Date.now() < retryAt) return
      if (queue.length >= maxPending) { dropped++; return }
      queue.push(line(event, fields))
      if (!worker) start()
    },
    async flush() { while (worker) await worker },
  }
}
