/**
 * DSH-Mod host half.
 *
 * Registers two generic Connection RPC channels instead of extending a
 * static host.* RPC map (which no longer exists as such upstream: since
 * deepseek-harness 0.1.3 the Remote catalog is slash-separated
 * namespace/method endpoints on the shared /api channel):
 *
 * - /mod-workspace-files
 *   endpoint `search` walks one directory tree and returns files whose
 *   root-relative path contains the query. The implementation mirrors the
 *   upstream file-reference discovery behavior: 50 matches / 100k visited
 *   entries, hidden/VCS directories and node_modules pruned, symlinks skipped.
 *   Matches carry `path` as the native absolute path (for example
 *   `D:\repo\src\index.ts`), plus `name` and `dir` as its basename and
 *   absolute parent directory.
 *
 * - /mod-workspace-open
 *   endpoint `describe` reports whether a native desktop opener is plausible;
 *   endpoint `open` hands a path to the OS default application. The browser
 *   half only surfaces the button on loopback pages (connection.isLoopback),
 *   which preserves the old host.openPath privilege boundary client-side.
 *
 * Access control note: ctx.connection.rpc.handle takes (channel, handler)
 * only. Every /api request — these channels included — passes the
 * process-wide browser-trust fence (loopback or --trusted-host authority
 * plus the launch-token/cookie browser session); there is no per-channel
 * authority argument, and the pre-0.1.3 third options argument was silently
 * ignored anyway.
 */

import { opendir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { release as osRelease } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { startGateway } from './gateway.js'

export const name = 'dsh-mod-workspace-files'

/**
 * Services required before this plugin may register its RPC channels.
 * `webServer` is required since deepseek-harness 0.1.3: rpc.handle now mounts
 * each channel through the owning fiber's webServer.register, and cordis
 * refuses ctx.webServer without a declared inject.
 */
export const inject = ['connection', 'webServer']

const FILE_SEARCH_MAX_MATCHES = 50
const FILE_SEARCH_MAX_VISITED = 100_000
const SEARCH_QUERY_MAX_CODE_UNITS = 100

const ok = value => ({ ok: true, value })
const err = (code, message, details = {}) => ({ ok: false, error: { code, message, details } })

function prunedDirectory(name) {
  return name.startsWith('.') || name === 'node_modules'
}

function rankOf(name, needle) {
  const base = name.toLowerCase()
  if (base.startsWith(needle)) return 0
  if (base.includes(needle)) return 1
  return 2
}

function compareMatches(a, b, needle) {
  const rank = rankOf(a.name, needle) - rankOf(b.name, needle)
  if (rank !== 0) return rank
  if (a.path.length !== b.path.length) return a.path.length - b.path.length
  return a.path.localeCompare(b.path)
}

function displayPathOf(root, filePath) {
  return relative(root, filePath).split(sep).join('/')
}

/**
 * Search one directory tree for files whose root-relative path contains the
 * query (case-insensitive substring). Each result reports the native absolute
 * path (drive-letter-rooted on Windows), matching the full-path insertion the
 * browser half performs.
 */
async function searchFilesInDirectory(root, query, signal) {
  const needle = query.toLowerCase()
  const matches = []
  let visited = 0
  const pending = [root]
  while (pending.length > 0 && visited < FILE_SEARCH_MAX_VISITED) {
    signal?.throwIfAborted()
    const current = pending.pop()
    if (current === undefined) continue
    let dir
    try {
      dir = await opendir(current)
    } catch (error) {
      if (signal?.aborted) throw error
      if (current === root) throw error
      continue
    }
    try {
      for await (const entry of dir) {
        signal?.throwIfAborted()
        visited += 1
        if (visited > FILE_SEARCH_MAX_VISITED) break
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) {
          if (!prunedDirectory(entry.name)) pending.push(join(current, entry.name))
          continue
        }
        const filePath = join(current, entry.name)
        const display = displayPathOf(root, filePath)
        if (!display.toLowerCase().includes(needle)) continue
        matches.push({
          path: filePath,
          name: entry.name,
          dir: dirname(filePath),
        })
      }
    } catch (error) {
      if (signal?.aborted) throw error
      if (current === root) throw error
    }
  }
  matches.sort((a, b) => compareMatches(a, b, needle))
  return matches.slice(0, FILE_SEARCH_MAX_MATCHES)
}

/** Run one shell-free native command and collect stderr for diagnostics. */
function runNative(command, args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      ...(signal === undefined ? {} : { signal }),
    })
    let stderr = ''
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) resolve()
      else reject(new Error(stderr.trim() || `${command} exited with code ${String(code)}`))
    })
  })
}

function powershellLiteral(path) {
  return `'${String(path).replace(/'/g, "''")}'`
}

function isWsl() {
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true
  return osRelease().toLowerCase().includes('microsoft')
}

function canOpenNativePath() {
  if (process.platform === 'darwin' || process.platform === 'win32') return true
  if (process.platform !== 'linux') return false
  if (isWsl()) return true
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
}

async function openNativePath(path, signal) {
  if (process.platform === 'darwin') {
    await runNative('open', [path], signal)
    return
  }
  if (process.platform === 'win32') {
    await runNative('powershell.exe', [
      '-NoProfile',
      '-Command',
      `Invoke-Item -LiteralPath ${powershellLiteral(path)}`,
    ], signal)
    return
  }
  if (process.platform === 'linux') {
    if (isWsl()) {
      const translated = await runNativeCapture('wslpath', ['-w', path], signal)
      signal?.throwIfAborted()
      const windowsPath = translated.trim()
      if (windowsPath === '') throw new Error('wslpath returned no Windows path')
      await runNative('powershell.exe', [
        '-NoProfile',
        '-Command',
        `Invoke-Item -LiteralPath ${powershellLiteral(windowsPath)}`,
      ], signal)
      return
    }
    await runNative('xdg-open', [path], signal)
    return
  }
  throw new Error(`native path opener is unsupported on ${process.platform}`)
}

function runNativeCapture(command, args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(signal === undefined ? {} : { signal }),
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => {
      stdout += String(chunk)
    })
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) resolve(stdout)
      else reject(new Error(stderr.trim() || `${command} exited with code ${String(code)}`))
    })
  })
}

/** /mod-workspace-files channel handler. */
async function handleSearch(endpoint, payload, signal) {
  if (endpoint !== 'search') return err('bad-request', `unknown endpoint ${endpoint}`, { endpoint })
  if (typeof payload !== 'object' || payload === null) {
    return err('bad-request', 'payload must be an object', {})
  }
  const path = payload.path
  const query = payload.query
  if (typeof path !== 'string' || path.length === 0) {
    return err('bad-request', 'path must be a non-empty string', {})
  }
  if (typeof query !== 'string' || query.trim() === '' || query.length > SEARCH_QUERY_MAX_CODE_UNITS) {
    return err('bad-request', 'query must be non-blank and at most 100 UTF-16 code units', {})
  }
  try {
    const matches = await searchFilesInDirectory(path, query, signal)
    return ok({ matches })
  } catch (error) {
    if (signal?.aborted) return err('cancelled', 'file search was aborted', {})
    return err('file-search-failed', `cannot search files under "${path}": ${String(error)}`, { path })
  }
}

/** /mod-workspace-open channel handler. */
async function handleOpen(endpoint, payload, signal) {
  if (endpoint === 'describe') return ok({ canOpen: canOpenNativePath() })
  if (endpoint !== 'open') return err('bad-request', `unknown endpoint ${endpoint}`, { endpoint })
  if (typeof payload !== 'object' || payload === null) {
    return err('bad-request', 'payload must be an object', {})
  }
  const path = payload.path
  if (typeof path !== 'string' || path.length === 0) {
    return err('bad-request', 'path must be a non-empty string', {})
  }
  try {
    await openNativePath(path, signal)
    return ok({ opened: true })
  } catch (error) {
    if (signal?.aborted) return err('cancelled', 'path open was aborted', {})
    return err('internal', `path open failed: ${String(error)}`, {})
  }
}

/**
 * This process's dsh web launch token, so the gateway can bootstrap paired
 * phones into the upstream browser-auth session (see gateway.js). The token
 * is per-process and is the same one printed in the
 * `dsh web: http://127.0.0.1:3080/?token=...` startup line.
 */
function launchTokenOf(ctx) {
  try {
    const authenticated = ctx.connection?.authenticatedUrl?.('http://127.0.0.1/')
    if (typeof authenticated === 'string') {
      const token = new URL(authenticated).searchParams.get('token')
      if (token !== null && token !== '') return token
    }
  } catch {
    /* shape drift across versions: gateway falls back to manual token entry */
  }
  return undefined
}

/** One client-request envelope on a generic channel (mirrors upstream rpc-schema). */
const ENVELOPE_MAX_BYTES = 1_000_000
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/

function endpointFromPath(channel, pathname) {
  if (!pathname.startsWith(`${channel}/`)) return undefined
  const endpoint = pathname.slice(channel.length + 1)
  const segments = endpoint.split('/')
  if (segments.some(segment =>
    segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT_PATTERN.test(segment))) {
    return undefined
  }
  return endpoint
}

function sendEnvelope(res, rpcId, result) {
  const body = JSON.stringify({ type: 'server-response', rpcId, result })
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(body)
}

/**
 * Fallback channel route for deepseek-harness 0.1.3–0.1.5: rpc.handle's owner
 * fiber does not declare `webServer`, so on the real web profile every generic
 * channel registration throws ("cannot get property webServer without inject";
 * in-tree tests provide webServer at an unrestricted root, so upstream has not
 * seen it). The fallback re-registers the same wire protocol — Host/Origin +
 * browser-auth fence via connection.requestRejection, then the
 * client-request/server-response envelope — on this plugin's own
 * webServer-injected fiber. Prefer the official API first so the fallback
 * retires itself once the owner fiber is fixed upstream.
 */
function fallbackChannelRoute(connection, channel, handler) {
  return {
    kind: 'prefix',
    path: channel,
    handler: async (req, res) => {
      const rejection = connection.requestRejection(req)
      if (rejection !== undefined) {
        res.writeHead(rejection)
        res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      const endpoint = endpointFromPath(channel, req.url ?? '/')
      if (req.method !== 'POST' || endpoint === undefined) {
        res.writeHead(404)
        res.end('not found')
        return
      }
      const mediaType = String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase()
      if (mediaType !== 'application/json') {
        res.writeHead(415)
        res.end('content type must be application/json')
        return
      }
      const chunks = []
      let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > ENVELOPE_MAX_BYTES) {
          res.writeHead(413)
          res.end('payload too large')
          return
        }
        chunks.push(chunk)
      }
      let message
      try {
        message = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        res.writeHead(400)
        res.end('body is not JSON')
        return
      }
      const valid = message !== null && typeof message === 'object'
        && message.type === 'client-request'
        && typeof message.rpcId === 'string' && message.rpcId !== ''
        && typeof message.method === 'string'
      if (!valid) {
        sendEnvelope(res, 'invalid-request', {
          ok: false,
          error: { code: 'gateway/bad-request', message: 'invalid client-request message', details: { issues: [] } },
        })
        return
      }
      if (message.method !== endpoint) {
        sendEnvelope(res, message.rpcId, {
          ok: false,
          error: {
            code: 'gateway/bad-request',
            message: `method ${JSON.stringify(message.method)} does not match endpoint ${JSON.stringify(endpoint)}`,
            details: { issues: [] },
          },
        })
        return
      }
      try {
        sendEnvelope(res, message.rpcId, await handler(endpoint, message.payload, undefined))
      } catch (error) {
        res.writeHead(500)
        res.end(`handler failure: ${String(error)}`)
      }
    },
  }
}

/**
 * Register one generic channel through the official API when it works, or the
 * wire-compatible fallback route otherwise (see fallbackChannelRoute).
 * @returns disposer matching rpc.handle's () => Promise<void>.
 */
function registerChannel(ctx, channel, handler) {
  try {
    return ctx.connection.rpc.handle(channel, handler)
  } catch (error) {
    if (!String(error).includes('without inject')) throw error
    let fallbackDisposer
    ctx.inject(['webServer', 'connection'], webCtx => {
      const route = fallbackChannelRoute(webCtx.connection, channel, handler)
      fallbackDisposer = webCtx.effect(
        () => webCtx.webServer.register(route),
        `dsh-mod: ${channel} rpc channel (webServer fallback)`,
      )
    })
    return async () => { await fallbackDisposer?.() }
  }
}

/**
 * Register both channels. `ctx.connection.rpc.handle` installs each physical
 * route through the owning Connection service; this plugin's effect keeps the
 * returned disposers so unloading the plugin also removes the channels.
 * @param ctx - Cordis host context carrying `connection`.
 */
export function apply(ctx) {
  const disposeSearch = registerChannel(ctx, '/mod-workspace-files', handleSearch)
  const disposeOpen = registerChannel(ctx, '/mod-workspace-open', handleOpen)
  ctx.effect(() => async () => {
    await Promise.all([disposeSearch(), disposeOpen()])
  }, 'dsh-mod-workspace-files: RPC channels')

  // Remote-access gateway (opt-in): starts only when the launcher exports
  // DSH_MOD_GATEWAY_PORT (see the workspace start-dsh.bat). Disabled returns
  // undefined and nothing is registered.
  const stopGateway = startGateway(process.env, { launchToken: launchTokenOf(ctx) })
  if (stopGateway !== undefined) {
    ctx.effect(() => stopGateway(), 'dsh-mod-workspace-files: remote gateway')
  }
}
