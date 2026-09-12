import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { once } from 'node:events'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { startGateway } from '../lib/gateway.js'
import { createDiagnostics, diagnosticPath } from '../lib/diagnostics.js'
import { apply } from '../lib/index.js'

async function until(check) {
  for (let i = 0; i < 150; i++) {
    const value = await check()
    if (value) return value
    await delay(10)
  }
  assert.fail('condition did not settle')
}

async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-gateway-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function fixture(t, { handle = (_req, res) => res.end('ok'), upgrade, timeout = 200, launchToken } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-gateway-test-'))
  const sockets = new Set()
  const upstream = createServer(handle)
  upstream.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  if (upgrade) upstream.on('upgrade', (...args) => {
    const socket = args[1]
    socket.on('end', () => socket.end())
    upgrade(...args)
    socket.resume()
  })
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const reserve = createServer()
  reserve.listen(0, '127.0.0.1')
  await once(reserve, 'listening')
  const port = reserve.address().port
  await new Promise(resolve => reserve.close(resolve))
  const logPath = join(home, 'logs', 'dsh-mod-gateway.jsonl')
  const stop = startGateway({
    DSH_HOME: home, DSH_MOD_GATEWAY_PORT: String(port), DSH_MOD_GATEWAY_BIND: '127.0.0.1',
    DSH_MOD_GATEWAY_TARGET: `127.0.0.1:${upstream.address().port}`,
    DSH_MOD_GATEWAY_CODE: 'TEST-1234', DSH_MOD_GATEWAY_WS_HANDSHAKE_TIMEOUT_MS: String(timeout),
  }, { launchToken })
  t.after(async () => {
    await stop()
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => upstream.close(resolve))
    await rm(home, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${port}`
  await until(async () => { try { return (await fetch(base + '/mod-gateway/health')).ok } catch { return false } })
  const paired = await fetch(base + '/mod-gateway/pair', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'TEST-1234' }),
  })
  const { token } = await paired.json()
  const cookie = `dshgw=${token}`
  const entries = async () => {
    try { return (await readFile(logPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) }
    catch { return [] }
  }
  async function openSocket(path = '/api/remote.mux?token=QUERY_SECRET', authed = true) {
    const socket = connect(port, '127.0.0.1')
    socket.on('error', () => {})
    t.after(() => socket.destroy())
    await once(socket, 'connect')
    socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nAuthorization: Bearer HEADER_SECRET\r\n${authed ? `Cookie: ${cookie}\r\n` : ''}\r\n`)
    return socket
  }
  return { base, cookie, token, logPath, entries, openSocket, stop, upstream }
}

test('JSONL rotation is bounded, private, and drops non-diagnostic fields', async t => {
  const dir = await directory(t)
  const path = join(dir, 'gateway.jsonl')
  const logger = createDiagnostics(path, { maxBytes: 512 })
  for (let i = 0; i < 40; i++) logger.record('http.complete', { id: i, status: 200, cookie: 'SECRET', body: 'PROMPT', token: 'KEY' })
  await logger.flush()
  const files = await readdir(dir)
  assert.equal(files.length, 3)
  for (const file of files) {
    const info = await stat(join(dir, file))
    assert.ok(info.size <= 512)
    assert.equal(info.mode & 0o777, 0o600)
    const text = await readFile(join(dir, file), 'utf8')
    assert.doesNotMatch(text, /SECRET|PROMPT|KEY/)
    text.trim().split('\n').forEach(line => assert.ok(JSON.parse(line).time))
  }
  assert.equal(diagnosticPath('/api/session/list?token=secret'), '/api/session/list')
  assert.equal(diagnosticPath('/files/private-project/secret.txt'), '/other')
})

test('logging overload and disk failure do not break callers', async t => {
  const dir = await directory(t)
  const logger = createDiagnostics(join(dir, 'log'), { maxPending: 2 })
  for (let i = 0; i < 100; i++) logger.record('test', { id: i })
  await logger.flush()
  assert.match(await readFile(join(dir, 'log'), 'utf8'), /log.dropped/)
  await writeFile(join(dir, 'file'), 'not a directory')
  const errors = []
  const failing = createDiagnostics(join(dir, 'file', 'log'), { onError: code => errors.push(code) })
  failing.record('test')
  await failing.flush()
  assert.equal(errors.length, 1)
  const disabled = createDiagnostics(undefined)
  disabled.record('test')
  await disabled.flush()
})

test('HTTP completion, auth failure and upstream reset have correlated safe logs', async t => {
  const f = await fixture(t, { handle: (req, res) => {
    if (req.url.startsWith('/api/reset')) { res.writeHead(200); res.write('partial'); setTimeout(() => res.destroy(), 10) }
    else { req.resume(); res.end('ok') }
  } })
  assert.equal((await fetch(f.base + '/api/session/list?token=QUERY_SECRET', {
    method: 'POST', headers: { cookie: f.cookie, authorization: 'Bearer HEADER_SECRET' }, body: 'BODY_SECRET',
  })).status, 200)
  assert.equal((await fetch(f.base + '/api/session/list')).status, 401)
  assert.equal((await fetch(f.base + '/api/settings/update', { method: 'POST', headers: { cookie: f.cookie } })).status, 403)
  const reset = await fetch(f.base + '/api/reset', { headers: { cookie: f.cookie } })
  await assert.rejects(reset.text())
  const entries = await until(async () => {
    const entries = await f.entries()
    return entries.some(e => e.event === 'http.error' && e.code === 'ECONNRESET') && entries
  })
  assert.ok(entries.some(e => e.status === 200 && e.upstreamStatus === 200 && e.upstreamMs >= 0 && e.path === '/api/session/list'))
  assert.ok(entries.some(e => e.status === 401))
  assert.ok(entries.some(e => e.status === 403))
  assert.doesNotMatch(await readFile(f.logPath, 'utf8'), new RegExp(`${f.token}|QUERY_SECRET|HEADER_SECRET|BODY_SECRET|TEST-1234`))
})

test('aborting HTTP cancels the pending upstream request', async t => {
  let accepted = false, closed = false
  const f = await fixture(t, { handle: (req, res) => { accepted = true; res.on('close', () => { closed = true }) } })
  const controller = new AbortController()
  const pending = fetch(f.base + '/api/session/list', { headers: { cookie: f.cookie }, signal: controller.signal }).catch(() => {})
  await until(() => accepted)
  controller.abort()
  await pending
  await until(() => closed)
  await until(async () => (await f.entries()).some(e => e.event === 'http.aborted'))
})

test('split WS handshake forwards bytes, survives idle, and client close releases upstream', async t => {
  let peer, received = ''
  const f = await fixture(t, { upgrade: (_req, socket) => {
    peer = socket
    socket.write('HTTP/1.1 10')
    setTimeout(() => socket.write('1 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSet-Cookie: SERVER_SECRET\r\n\r\n'), 10)
    socket.on('data', data => { received += data.toString(); socket.write(data) })
  } })
  const client = await f.openSocket()
  let bytes = ''
  client.on('data', chunk => { bytes += chunk.toString() })
  await until(() => bytes.includes('\r\n\r\n'))
  client.write('PAYLOAD_SECRET')
  await until(() => received.includes('PAYLOAD_SECRET') && bytes.includes('PAYLOAD_SECRET'))
  await delay(250)
  assert.equal(client.destroyed, false, 'handshake deadline must not become an idle timeout')
  client.destroy()
  await until(() => peer.destroyed)
  const entries = await until(async () => { const entries = await f.entries(); return entries.some(e => e.event === 'ws.closed') && entries })
  assert.ok(entries.some(e => e.event === 'ws.handshake' && e.upstreamStatus === 101))
  assert.ok(entries.some(e => e.event === 'ws.closed' && e.side === 'client' && e.clientBytes > 0))
  assert.doesNotMatch(await readFile(f.logPath, 'utf8'), /QUERY_SECRET|HEADER_SECRET|SERVER_SECRET|PAYLOAD_SECRET/)
})

test('stalled and incomplete WS handshakes time out and release both ends', async t => {
  for (const partial of ['', 'HTTP/1.1 101 Switching Protocols\r\n']) {
    let peer
    const f = await fixture(t, { timeout: 60, upgrade: (_req, socket) => { peer = socket; if (partial) socket.write(partial) } })
    const client = await f.openSocket()
    client.resume()
    await until(() => client.destroyed && peer?.destroyed)
    await until(async () => (await f.entries()).some(e => e.reason === 'handshake_timeout' && e.side === 'upstream'))
  }
})

test('upstream rejection and unpaired WS are logged without granting access', async t => {
  let upgrades = 0
  const f = await fixture(t, { upgrade: (_req, socket) => { upgrades++; socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n') } })
  const unpaired = await f.openSocket('/api/remote.mux', false)
  unpaired.resume()
  await until(() => unpaired.destroyed)
  assert.equal(upgrades, 0)
  const paired = await f.openSocket()
  let response = ''
  paired.on('data', chunk => { response += chunk.toString() })
  await until(() => paired.destroyed)
  assert.match(response, /403 Forbidden/)
  const entries = await until(async () => { const rows = await f.entries(); return rows.some(e => e.reason === 'handshake_rejected') && rows })
  assert.ok(entries.some(e => e.event === 'ws.rejected' && e.status === 401))
  assert.ok(entries.some(e => e.event === 'ws.handshake' && e.upstreamStatus === 403))
})

test('gateway disposal closes established upgraded sockets', async t => {
  let peer
  const f = await fixture(t, { upgrade: (_req, socket) => { peer = socket; socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n') } })
  const client = await f.openSocket()
  client.resume()
  await until(async () => (await f.entries()).some(e => e.event === 'ws.handshake'))
  await f.stop()
  await until(() => client.destroyed && peer.destroyed)
  assert.ok((await f.entries()).some(e => e.reason === 'shutdown'))
})

test('client disappearing during a pending WS handshake releases the tunnel', async t => {
  let peer
  const f = await fixture(t, { timeout: 1000, upgrade: (_req, socket) => { peer = socket } })
  const client = await f.openSocket()
  await until(() => peer)
  client.destroy()
  await until(() => peer.destroyed)
  await until(async () => (await f.entries()).some(e => e.event === 'ws.closed' && e.side === 'client' && e.durationMs < 1000))
})

test('index authentication bootstrap still merges both cookies without logging secrets', async t => {
  let exchanges = 0
  const f = await fixture(t, { launchToken: 'LAUNCH_SECRET', handle: (req, res) => {
    if (!req.url.includes('token=LAUNCH_SECRET')) { res.writeHead(401); res.end(); return }
    exchanges++
    res.writeHead(303, { location: '/', 'set-cookie': `session${exchanges}=COOKIE_SECRET_${exchanges}; Path=/; HttpOnly` })
    res.end()
  } })
  const response = await fetch(f.base + '/', { headers: { cookie: f.cookie }, redirect: 'manual' })
  await response.text()
  assert.equal(response.status, 303)
  assert.equal(exchanges, 2)
  assert.equal(response.headers.getSetCookie().length, 2)
  await until(async () => (await f.entries()).some(e => e.event === 'http.complete' && e.path === '/' && e.status === 303))
  assert.doesNotMatch(await readFile(f.logPath, 'utf8'), /LAUNCH_SECRET|COOKIE_SECRET/)
})

test('plugin activation keeps gateway alive until the Cordis effect is disposed', async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-plugin-test-'))
  const reserve = createServer()
  reserve.listen(0, '127.0.0.1')
  await once(reserve, 'listening')
  const port = reserve.address().port
  await new Promise(resolve => reserve.close(resolve))
  const env = { DSH_HOME: home, DSH_MOD_GATEWAY_PORT: String(port), DSH_MOD_GATEWAY_BIND: '127.0.0.1' }
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
  const effects = []
  let removedChannels = 0
  t.after(async () => {
    for (const dispose of effects) if (typeof dispose === 'function') await dispose()
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(home, { recursive: true, force: true })
  })
  Object.assign(process.env, env)
  apply({
    connection: { rpc: { handle: () => async () => { removedChannels++ } } },
    effect(factory) { const dispose = factory(); effects.push(dispose); return dispose },
  })
  assert.equal(effects.length, 2)
  assert.equal(typeof effects[1], 'function', 'effect must return the cleanup instead of running it')
  await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/mod-gateway/health`)).ok } catch { return false } })
  assert.equal(removedChannels, 0)
  await effects[1]()
  await assert.rejects(fetch(`http://127.0.0.1:${port}/mod-gateway/health`))
})
