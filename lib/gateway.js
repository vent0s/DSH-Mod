/**
 * dsh-mod remote-access gateway (host half, opt-in via DSH_MOD_GATEWAY_PORT).
 *
 * Serves an externally reachable front door for an otherwise loopback-only
 * `dsh web` deployment. The upstream webserver keeps binding 127.0.0.1 (the
 * CLI blocks 0.0.0.0 on purpose); this gateway listens on 0.0.0.0:<port> and
 * reverse-proxies HTTP and WebSocket traffic to that loopback server.
 *
 * Security model, layered:
 * 1. Pairing/token gate (this gateway). Every proxied request — including the
 *    two WebSocket event streams — must carry the cookie issued after entering
 *    the pairing code printed in the host console. Tokens are stored hashed;
 *    all of them can be revoked at once with the current pairing code.
 * 2. Privileged-RPC block (this gateway, mirrored list minus read-only
 *    exceptions). Credentials, settings mutations and preset management never
 *    pass through the gateway, token or not; the read-only settings.describe
 *    is allowed because the web client's boot requires it.
 * 3. Upstream Host fence (deepseek-harness client-connection). The proxy
 *    forwards each client's original Host header, so the upstream fence keeps
 *    treating remote callers as non-loopback: the launcher passes this
 *    machine's IPv4 literals via --trusted-host so ordinary RPC passes, while
 *    the privileged set stays pinned to loopback upstream as well.
 *
 * The gateway also serves a small connection-manager page at /mod-gateway/
 * (saved connections live in the phone browser's local storage), a CORS-open
 * /mod-gateway/health probe, and the pair/revoke endpoints.
 */

import { createServer, request as httpRequest, Agent } from 'node:http'
import { connect as netConnect } from 'node:net'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { homedir, hostname, networkInterfaces } from 'node:os'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const GATEWAY_ROOT = '/mod-gateway/'
const COOKIE_NAME = 'dshgw'
const STATE_FILE = '.dsh-mod-gateway.json'
const STATE_VERSION = 1
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
const CODE_LENGTH = 8
const TOKEN_BYTES = 32
const MAX_TOKENS = 50
const MAX_FAILED_PAIRS = 10
const LOCKOUT_MS = 120_000

/**
 * Privileged RPC the gateway never forwards, mirrored from deepseek-harness
 * client-connection PRIVILEGED_METHODS minus GATEWAY_READ_EXCEPTIONS. The
 * upstream Host fence is the primary boundary (original Host headers make
 * remote callers non-loopback there); this mirror is defense in depth so the
 * property survives even if some other path ever rewrites the Host. The
 * configuration plane stays on loopback 3080.
 */
const GATEWAY_READ_EXCEPTIONS = new Set([
  // The web client's boot (settings mirror) requires this read-only describe;
  // without it the sidebar never populates workspaces/sessions. Pairing-gated
  // remote devices may VIEW configuration. Everything that mutates settings,
  // touches credentials, or probes the network (llm.discoverModels) stays
  // blocked below.
  'settings.describe',
])

const PRIVILEGED_METHODS = new Set([
  'agentPreset.read',
  'agentPreset.copy',
  'agentPreset.openDocument',
  'agentPreset.remove',
  'host.pickDirectory',
  'host.openPath',
  'settings.openDocument',
  'settings.update',
  'settings.replace',
  'settings.mutate',
  'credentials.describe',
  'credentials.set',
  'credentials.unset',
  'llm.discoverModels',
])

const sha256 = value => createHash('sha256').update(value).digest()

function safeEqual(a, b) {
  return a.length === b.length && timingSafeEqual(a, b)
}

function newPairingCode() {
  const bytes = randomBytes(CODE_LENGTH)
  let code = ''
  for (const byte of bytes) code += CODE_ALPHABET[byte % CODE_ALPHABET.length]
  return code
}

function formatCode(code) {
  return `${code.slice(0, CODE_LENGTH / 2)}-${code.slice(CODE_LENGTH / 2)}`
}

function lanIpv4Addresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter(iface => iface !== undefined && iface.family === 'IPv4' && !iface.internal)
    .map(iface => iface.address)
}

function stateFilePath(env) {
  const home = env.DSH_HOME !== undefined && env.DSH_HOME !== '' ? env.DSH_HOME : join(homedir(), '.dsh')
  return join(home, STATE_FILE)
}

async function loadState(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && parsed.version === STATE_VERSION
      && typeof parsed.pairingCode === 'string' && Array.isArray(parsed.tokenHashes)) {
      return parsed
    }
  } catch {
    /* first run or unreadable state: fall through to a fresh one */
  }
  return { version: STATE_VERSION, pairingCode: newPairingCode(), tokenHashes: [] }
}

async function saveState(path, state) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

function readCookie(req, name) {
  const header = req.headers.cookie
  if (typeof header !== 'string') return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return undefined
}

function isAuthed(state, req) {
  const token = readCookie(req, COOKIE_NAME)
  if (token === undefined) return false
  const hash = sha256(token)
  return state.tokenHashes.some(stored => safeEqual(Buffer.from(stored, 'hex'), hash))
}

function issueToken(state) {
  const token = randomBytes(TOKEN_BYTES).toString('base64url')
  state.tokenHashes.push(sha256(token).toString('hex'))
  while (state.tokenHashes.length > MAX_TOKENS) state.tokenHashes.shift()
  return token
}

/** Per-source-IP throttle for pairing/revoke guesses. */
function createAttemptTracker() {
  const attempts = new Map()
  const key = req => String(req.socket.remoteAddress ?? 'unknown')
  return {
    isLocked(req) {
      const entry = attempts.get(key(req))
      return entry !== undefined && entry.lockedUntil > Date.now()
    },
    registerFailure(req) {
      const k = key(req)
      const entry = attempts.get(k) ?? { fails: 0, lockedUntil: 0 }
      entry.fails += 1
      if (entry.fails >= MAX_FAILED_PAIRS) {
        entry.fails = 0
        entry.lockedUntil = Date.now() + LOCKOUT_MS
      }
      attempts.set(k, entry)
    },
    registerSuccess(req) {
      attempts.delete(key(req))
    },
  }
}

function readJsonBody(req, limitBytes = 2048) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > limitBytes) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve(text === '' ? {} : JSON.parse(text))
      } catch {
        reject(new Error('invalid json body'))
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, body, extraHeaders = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...extraHeaders })
  res.end(JSON.stringify(body))
}

function sendHtml(res, status, html, extraHeaders = {}) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...extraHeaders })
  res.end(html)
}

/** Connection-manager front page; kept inline so the gateway stays one file. */const SHELL_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>DSH 远程</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;background:#10141a;color:#e8eaed}
.wrap{max-width:560px;margin:0 auto;padding:20px 16px calc(36px + env(safe-area-inset-bottom))}
h1{font-size:20px;margin:6px 0 18px;display:flex;align-items:center;gap:10px}
.logo{width:30px;height:30px;border-radius:9px;background:#2f6fdb;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:12px;color:#fff;flex:0 0 auto}
.card{background:#181e26;border:1px solid #262f3a;border-radius:14px;padding:16px;margin-bottom:14px}
.card h2{font-size:13px;margin:0 0 12px;color:#8b96a5;font-weight:600;letter-spacing:.04em;text-transform:uppercase}
.btn{display:inline-block;border:0;border-radius:10px;padding:12px 16px;font-size:15px;background:#2f6fdb;color:#fff;cursor:pointer;text-decoration:none}
.btn.full{display:block;width:100%;text-align:center}
.btn.ghost{background:#232b36;color:#c6cdd7}
.btn.small{padding:7px 11px;font-size:13px;border-radius:8px}
input{width:100%;border:1px solid #2c3541;background:#12171d;color:#e8eaed;border-radius:10px;padding:12px;font-size:16px;margin-bottom:10px}
input:focus{outline:2px solid #2f6fdb;border-color:transparent}
.row{display:flex;gap:8px}
.row input{margin-bottom:0}
.item{display:flex;align-items:center;gap:10px;padding:12px 4px;border-bottom:1px solid #222a34}
.item:last-child{border-bottom:0}
.dot{width:10px;height:10px;border-radius:50%;background:#5a6472;flex:0 0 auto}
.dot.on{background:#3fb950}
.dot.off{background:#f85149}
.meta{flex:1;min-width:0}
.meta .name{font-weight:600;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.meta .addr{font-size:12px;color:#8b96a5}
.muted{color:#8b96a5;font-size:13px;line-height:1.6}
.msg{font-size:13px;min-height:18px;margin:8px 0 0}
.err{color:#f85149}
.ok{color:#3fb950}
</style>
</head>
<body>
<div class="wrap">
<h1><span class="logo">DSH</span>远程控制台</h1>

<div class="card">
  <h2>本机</h2>
  <div id="pairBox" style="display:none">
    <div class="muted">需要配对:配对码显示在电脑上 "DSH Server" 窗口里的 dsh-mod-gateway 日志行。配对一次长期有效,令牌保存在本机;换新设备时凭配对码即可(配对码固定不变)。</div>
    <div style="height:10px"></div>
    <input id="code" autocapitalize="characters" autocomplete="off" placeholder="输入配对码">
    <button class="btn full" id="pairBtn">配对</button>
    <div class="msg" id="pairMsg"></div>
  </div>
  <div id="enterBox" style="display:none">
    <a class="btn full" href="/">进入 DSH</a>
    <div style="height:10px"></div>
    <div class="muted">要断开所有已配对手机:在下方用<b>当前</b>配对码执行吊销。</div>
  </div>
</div>

<div class="card">
  <h2>我的电脑</h2>
  <div id="list"></div>
  <div style="height:12px"></div>
  <div class="row">
    <input id="nName" placeholder="备注名(可选)">
    <input id="nHost" placeholder="IP 或主机名" style="flex:1.4">
    <input id="nPort" inputmode="numeric" placeholder="端口" value="3180" style="flex:.7">
  </div>
  <div style="height:10px"></div>
  <button class="btn full" id="addBtn">添加</button>
  <div class="msg" id="addMsg"></div>
</div>

<div class="card">
  <h2>吊销全部令牌</h2>
  <div class="muted">输入电脑上的配对码,这台电脑上所有已配对设备立即失效(配对码不变,之后可重新配对)。怀疑配对码泄露时,应同时在电脑上修改启动配置里的 <b>DSH_MOD_GATEWAY_CODE</b>。</div>
  <div style="height:10px"></div>
  <input id="rCode" autocapitalize="characters" autocomplete="off" placeholder="当前配对码">
  <button class="btn ghost full" id="revokeBtn">吊销</button>
  <div class="msg" id="revokeMsg"></div>
</div>

<p class="muted">连接信息只保存在这台手机的本地存储里。首次从手机访问时 Windows 可能弹出防火墙提示,选择“允许”。</p>
</div>
<script>
(function(){
  var KEY='dshgw-connections';
  function load(){try{return JSON.parse(localStorage.getItem(KEY)||'[]')}catch(e){return[]}}
  function save(l){localStorage.setItem(KEY,JSON.stringify(l))}
  function msg(el,text,cls){el.textContent=text;el.className='msg '+(cls||'')}
  function post(path,body){
    return fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
      .then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j}})})
  }

  function post(path,body){
    return fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
      .then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j}})})
  }
  function savedTokenKey(hostId){return 'dshgw-token-'+hostId}

  fetch('/mod-gateway/state').then(function(r){return r.json()}).then(function(s){
    if(s.authed){document.getElementById('enterBox').style.display='block';return}
    // Cookie missing but this phone already paired with this computer before
    // (any address): exchange the saved token for a fresh cookie silently.
    var saved=localStorage.getItem(savedTokenKey(s.hostId||''));
    if(!saved){document.getElementById('pairBox').style.display='block';return}
    post('/mod-gateway/auth',{token:saved}).then(function(res){
      if(res.ok&&res.j.ok){location.reload()}
      else{document.getElementById('pairBox').style.display='block'}
    }).catch(function(){document.getElementById('pairBox').style.display='block'});
  }).catch(function(){document.getElementById('pairBox').style.display='block'});

  var pairMsg=document.getElementById('pairMsg');
  document.getElementById('pairBtn').addEventListener('click',function(){
    var code=document.getElementById('code').value.trim();
    if(!code){msg(pairMsg,'请输入配对码','err');return}
    post('/mod-gateway/pair',{code:code}).then(function(res){
      if(res.ok&&res.j.ok){
        if(res.j.hostId&&res.j.token)localStorage.setItem(savedTokenKey(res.j.hostId),res.j.token);
        location.reload()
      }
      else{msg(pairMsg,(res.j&&res.j.error)||'配对失败:配对码不对或尝试过于频繁','err')}
    }).catch(function(){msg(pairMsg,'网络错误','err')});
  });

  var list=document.getElementById('list');
  function probe(c,dotEl,addrEl){
    dotEl.className='dot';addrEl.textContent=c.host+':'+c.port+' · 检测中…';
    var ctrl=new AbortController();var t=setTimeout(function(){ctrl.abort()},3000);
    fetch('http://'+c.host+':'+c.port+'/mod-gateway/health',{signal:ctrl.signal})
      .then(function(r){return r.json()})
      .then(function(j){clearTimeout(t);if(j&&j.ok){dotEl.className='dot on';addrEl.textContent=c.host+':'+c.port+' · '+(j.name||'')+' 在线'}
        else{dotEl.className='dot off';addrEl.textContent=c.host+':'+c.port+' · 离线'}})
      .catch(function(){clearTimeout(t);dotEl.className='dot off';addrEl.textContent=c.host+':'+c.port+' · 离线'});
  }
  function render(){
    var conns=load();list.innerHTML='';
    conns.forEach(function(c,idx){
      var item=document.createElement('div');item.className='item';
      var dot=document.createElement('span');dot.className='dot';
      var meta=document.createElement('div');meta.className='meta';
      var name=document.createElement('div');name.className='name';name.textContent=c.name||c.host;
      var addr=document.createElement('div');addr.className='addr';
      meta.appendChild(name);meta.appendChild(addr);
      var open=document.createElement('a');open.className='btn small';open.textContent='打开';
      open.href='http://'+c.host+':'+c.port+'/';
      var del=document.createElement('button');del.className='btn small ghost';del.textContent='删除';
      del.addEventListener('click',function(){var l=load();l.splice(idx,1);save(l);render()});
      item.appendChild(dot);item.appendChild(meta);item.appendChild(open);item.appendChild(del);
      list.appendChild(item);
      probe(c,dot,addr);
    });
    if(!conns.length){list.innerHTML='<div class="muted">还没有保存的电脑。添加一台:填电脑的 IP 和网关端口。</div>'}
  }
  render();

  var addMsg=document.getElementById('addMsg');
  document.getElementById('addBtn').addEventListener('click',function(){
    var host=document.getElementById('nHost').value.trim();
    var port=document.getElementById('nPort').value.trim()||'3180';
    var name=document.getElementById('nName').value.trim();
    if(!host){msg(addMsg,'请填 IP 或主机名','err');return}
    if(!/^\\d+$/.test(port)){msg(addMsg,'端口必须是数字','err');return}
    var l=load();l.push({name:name,host:host,port:port});save(l);
    document.getElementById('nName').value='';document.getElementById('nHost').value='';
    msg(addMsg,'已添加','ok');render();
  });

  var revokeMsg=document.getElementById('revokeMsg');
  document.getElementById('revokeBtn').addEventListener('click',function(){
    var code=document.getElementById('rCode').value.trim();
    if(!code){msg(revokeMsg,'请输入当前配对码','err');return}
    post('/mod-gateway/revoke',{code:code}).then(function(res){
      if(res.ok&&res.j.ok){msg(revokeMsg,'已吊销,请重新配对','ok')}
      else{msg(revokeMsg,(res.j&&res.j.error)||'吊销失败:配对码不对','err')}
    }).catch(function(){msg(revokeMsg,'网络错误','err')});
  });
})();
</script>
</body>
</html>
`

/**
 * Boot diagnostics recorder, injected into the proxied index.html only while
 * DSH_MOD_GATEWAY_DIAG=1 (see proxyHtmlDiag). Captures console error/warn,
 * window errors and rejections, /api + plugin fetch outcomes, and WebSocket
 * lifecycle into window.__diag for reading from a paired browser.
 */
const DIAG_SCRIPT = `
(function(){
  if (window.__diagInstalled) return
  window.__diagInstalled = true
  var diag = window.__diag = { errors: [], logs: [], fetches: [], sockets: [] }
  var push = function(arr, item) { if (arr.length < 400) arr.push(item) }
  var tag = function() { return Math.round(performance.now()) }
  var fmt = function(a) {
    if (typeof a === 'string') return a
    if (a && a.message) return a.message
    try { return JSON.stringify(a) } catch (e) { return String(a) }
  }
  var wrapLevel = function(name) {
    var original = console[name] ? console[name].bind(console) : function() {}
    console[name] = function() {
      try { push(diag.logs, name + ' @' + tag() + 'ms ' + Array.prototype.map.call(arguments, fmt).join(' ').slice(0, 400)) } catch (e) {}
      original.apply(null, arguments)
    }
  }
  wrapLevel('error')
  wrapLevel('warn')
  window.addEventListener('error', function(ev) {
    push(diag.errors, '@' + tag() + 'ms ' + (ev.message || '') + ' ' + (ev.filename || '') + ':' + (ev.lineno || 0))
  })
  window.addEventListener('unhandledrejection', function(ev) {
    push(diag.errors, '@' + tag() + 'ms unhandledrejection ' + String(ev.reason && (ev.reason.message || ev.reason)).slice(0, 300))
  })
  var rawFetch = window.fetch.bind(window)
  window.fetch = function(input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || ''
    var method = (init && init.method) || 'GET'
    var startedAt = tag()
    return rawFetch(input, init).then(function(res) {
      if (url.indexOf('/api/') === 0 || url.indexOf('/plugins/') === 0 || url === '/' || url.indexOf('/mod-gateway/') === 0) {
        push(diag.fetches, method + ' ' + url + ' -> ' + res.status + ' @' + startedAt + 'ms')
      }
      return res
    }, function(err) {
      push(diag.fetches, method + ' ' + url + ' -> ERR ' + String(err && err.message).slice(0, 120) + ' @' + startedAt + 'ms')
      throw err
    })
  }
  // NOTE: do NOT wrap window.WebSocket here. A plain-function wrapper
  // returning a raw socket broke the DSH app's stream opens on mobile
  // Chromium (EdgA): identical handshakes relayed and 101'd, yet the app's
  // sockets died pre-open while unwrapped ones opened fine. Record socket
  // telemetry only when the page itself opts in via diag.trackSocket.
  diag.trackSocket = function(ws) {
    var rec = { url: String(ws.url || ''), openedAt: null, messages: 0, errors: 0, closeCode: null }
    push(diag.sockets, rec)
    ws.addEventListener('open', function() { rec.openedAt = tag() })
    ws.addEventListener('message', function() { rec.messages++ })
    ws.addEventListener('error', function() { rec.errors++ })
    ws.addEventListener('close', function(e) { rec.closeCode = e.code })
    return ws
  }
  var panel = document.createElement('div')
  panel.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#000;color:#ff0;font:11px/1.45 monospace;padding:6px 8px;white-space:pre-wrap;pointer-events:none;border-bottom:2px solid #ff0'
  document.addEventListener('DOMContentLoaded', function() { document.body.appendChild(panel) })

  // Self-probes: replicate the app readiness handshake pieces and report them
  // in the panel, so the phone screen itself carries the diagnosis.
  diag.probe = 'probing...'
  ;(async function() {
    await new Promise(function(r) { setTimeout(r, 2500) })
    var lines = []
    try {
      var res = await fetch('/api/host.describe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'diag-probe', method: 'host.describe', payload: {} }),
      })
      lines.push('fetch host.describe -> HTTP ' + res.status)
    } catch (e) {
      lines.push('fetch host.describe -> ERR ' + String(e && e.message).slice(0, 80))
    }
    await new Promise(function(r) { setTimeout(r, 500) })
    lines.push(await new Promise(function(resolve) {
      var ws
      try { ws = new WebSocket(location.origin.replace('http', 'ws') + '/api/events.mux') } catch (e) { resolve('ws ERR ' + String(e && e.message).slice(0, 60)); return }
      var done = false
      var finish = function(v) { if (!done) { done = true; resolve(v) } }
      ws.onopen = function() { finish('ws OPEN ok'); try { ws.close() } catch (e) {} }
      ws.onerror = function() {}
      ws.onclose = function(ev) { finish('ws close ' + ev.code) }
      setTimeout(function() { finish('ws timeout'); try { ws.close() } catch (e) {} }, 4000)
    }))
    diag.probe = lines.join(' ; ')
  })()

  setInterval(function() {
    if (!document.body || !panel.isConnected) return
    var lines = ['[diag] origin=' + location.origin + ' | probe: ' + (diag.probe || 'n/a')]
    var socks = diag.sockets.slice(-4)
    if (socks.length === 0) lines.push('ws: none yet')
    for (var i = 0; i < socks.length; i++) {
      var s = socks[i]
      lines.push('ws ' + s.url.replace('ws://' + location.host, '') + ' -> ' +
        (s.openedAt !== null ? 'OPEN msgs=' + s.messages : 'FAIL code=' + s.closeCode))
    }
    var errs = diag.errors.slice(-3)
    lines.push('errors=' + diag.errors.length + (errs.length ? ' | ' + errs.join(' | ').slice(0, 200) : ''))
    var warns = diag.logs.filter(function(l) { return l.indexOf('web-runtime') >= 0 }).slice(-2)
    for (var w = 0; w < warns.length; w++) lines.push(warns[w].slice(0, 160))
    lines.push('apiCalls=' + diag.fetches.filter(function(f) { return f.indexOf('/api/') === 0 }).length +
      ' wsTotal=' + diag.sockets.length)
    panel.textContent = lines.join('\\n')
  }, 500)
})()
`

/**
 * Parse a `host:port` target; port defaults to 80 only when omitted (never in
 * practice — callers pass an explicit port).
 */function parseTarget(spec, fallbackPort) {
  const lastColon = spec.lastIndexOf(':')
  if (lastColon < 0) return { host: spec, port: fallbackPort }
  const port = Number(spec.slice(lastColon + 1))
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { host: spec, port: fallbackPort }
  return { host: spec.slice(0, lastColon), port }
}

/**
 * Start the gateway when DSH_MOD_GATEWAY_PORT names a usable port.
 * @param {NodeJS.ProcessEnv} env - environment to read (injected for tests).
 * @returns {() => void} disposer that closes the listener, or undefined when
 *   the gateway is disabled and nothing was started.
 */
export function startGateway(env = process.env) {
  const port = Number(env.DSH_MOD_GATEWAY_PORT)
  if (env.DSH_MOD_GATEWAY_PORT === undefined || env.DSH_MOD_GATEWAY_PORT === ''
    || !Number.isInteger(port) || port < 1 || port > 65535) {
    return undefined
  }
  const bind = env.DSH_MOD_GATEWAY_BIND || '0.0.0.0'
  const diagEnabled = env.DSH_MOD_GATEWAY_DIAG === '1'
  const fallbackPort = Number(env.DSH_PORT) > 0 ? Number(env.DSH_PORT) : 3080
  const target = parseTarget(env.DSH_MOD_GATEWAY_TARGET || '127.0.0.1', fallbackPort)
  const statePath = stateFilePath(env)
  const attempts = createAttemptTracker()
  // Pooled keep-alive toward the loopback upstream: the client side answers
  // Connection: close, so without a pool every proxied request would open a
  // fresh 127.0.0.1 socket.
  const upstreamAgent = new Agent({ keepAlive: true, keepAliveMsecs: 5000, maxSockets: 64 })

  /** Mutable gateway state; persisted on every mutation. */
  let state = { version: STATE_VERSION, pairingCode: newPairingCode(), tokenHashes: [] }
  let ready = false

  const log = (...args) => console.log('[dsh-mod-gateway]', ...args)
  const logError = (...args) => console.error('[dsh-mod-gateway]', ...args)

  const codeMatches = candidate => typeof candidate === 'string'
    && safeEqual(sha256(candidate.trim().toUpperCase()), sha256(state.pairingCode))

  async function handleGatewayRoute(req, res, pathname) {
    if (pathname === '/mod-gateway/health') {
      sendJson(res, 200, { ok: true, service: 'dsh-mod-gateway', name: hostname() }, {
        'access-control-allow-origin': '*',
        'cache-control': 'no-store',
      })
      return true
    }
    if (pathname === '/mod-gateway/state') {
      sendJson(res, 200, { authed: isAuthed(state, req), hostId: hostname() }, { 'cache-control': 'no-store' })
      return true
    }
    if (pathname === '/mod-gateway' ) {
      res.writeHead(301, { location: GATEWAY_ROOT })
      res.end()
      return true
    }
    if (pathname === '/mod-gateway/diag.js') {
      res.writeHead(200, {
        'content-type': 'application/javascript; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(DIAG_SCRIPT)
      return true
    }
    if (pathname === '/mod-gateway/pair' && req.method === 'GET') {
      // Link/QR pairing convenience: same rate limit and code check as POST;
      // issues the cookie then redirects into the app. The code travels in
      // the URL, so it lands in browser history — acceptable for a pairing
      // code the owner rotates at will.
      const code = new URL(req.url, 'http://gateway.invalid').searchParams.get('code') ?? ''
      if (attempts.isLocked(req)) {
        sendHtml(res, 429, '<!doctype html><meta charset="utf-8"><body>尝试过于频繁,请稍后再试</body>')
        return true
      }
      if (!codeMatches(code)) {
        attempts.registerFailure(req)
        sendHtml(res, 401, '<!doctype html><meta charset="utf-8"><body>配对码不对</body>')
        return true
      }
      attempts.registerSuccess(req)
      const token = issueToken(state)
      await saveState(statePath, state)
      log('paired a device via link')
      res.writeHead(302, {
        location: '/',
        'set-cookie': `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`,
        'cache-control': 'no-store',
      })
      res.end()
      return true
    }
    if (pathname === GATEWAY_ROOT || pathname === '/mod-gateway/index.html') {
      sendHtml(res, 200, SHELL_HTML, { 'cache-control': 'no-store' })
      return true
    }
    if (pathname === '/mod-gateway/pair' || pathname === '/mod-gateway/revoke'
      || pathname === '/mod-gateway/auth' || pathname === '/mod-gateway/rotate') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'POST only' })
        return true
      }
      // Modern browsers label the initiator on every fetch; refuse explicit
      // cross-site calls so a malicious page cannot drive pairing guesses.
      if (req.headers['sec-fetch-site'] === 'cross-site') {
        sendJson(res, 403, { ok: false, error: 'cross-site request refused' })
        return true
      }
      if (pathname === '/mod-gateway/auth') {
        // Token-for-cookie exchange: no pairing code involved. The shell keeps
        // the raw token in local storage per hostId, so a lost cookie (or a
        // switch between this machine's LAN / Tailscale addresses)
        // re-authenticates silently.
        let authBody
        try {
          authBody = await readJsonBody(req)
        } catch {
          sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
          return true
        }
        const supplied = typeof authBody.token === 'string' && authBody.token.length <= 128 ? authBody.token : ''
        if (supplied !== '' && state.tokenHashes.some(stored => safeEqual(Buffer.from(stored, 'hex'), sha256(supplied)))) {
          sendJson(res, 200, { ok: true, hostId: hostname() }, {
            'set-cookie': `${COOKIE_NAME}=${supplied}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`,
            'cache-control': 'no-store',
          })
        } else {
          sendJson(res, 401, { ok: false, error: 'token 无效' })
        }
        return true
      }
      if (attempts.isLocked(req)) {
        sendJson(res, 429, { ok: false, error: '尝试过于频繁,请 2 分钟后再试' })
        return true
      }
      let body
      try {
        body = await readJsonBody(req)
      } catch {
        sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
        return true
      }
      if (!codeMatches(body.code)) {
        attempts.registerFailure(req)
        sendJson(res, 401, { ok: false, error: '配对码不对' })
        return true
      }
      attempts.registerSuccess(req)
      if (pathname === '/mod-gateway/pair') {
        const token = issueToken(state)
        // The pairing code is STABLE by design (pair once per device, token
        // lives a year) so an owner can pair a new phone from memory even
        // away from home. Rotating happens only via /mod-gateway/rotate.
        await saveState(statePath, state)
        log('paired a device')
        sendJson(res, 200, { ok: true, token, hostId: hostname() }, {
          'set-cookie': `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`,
          'cache-control': 'no-store',
        })
      } else if (pathname === '/mod-gateway/rotate') {
        state.tokenHashes = []
        state.pairingCode = newPairingCode()
        await saveState(statePath, state)
        log(`rotated pairing code and revoked all tokens`)
        sendJson(res, 200, { ok: true }, { 'cache-control': 'no-store' })
      } else {
        state.tokenHashes = []
        await saveState(statePath, state)
        log('revoked all tokens (pairing code unchanged)')
        sendJson(res, 200, { ok: true }, { 'cache-control': 'no-store' })
      }
      return true
    }
    if (pathname.startsWith(GATEWAY_ROOT)) {
      sendJson(res, 404, { ok: false, error: 'not found' })
      return true
    }
    return false
  }

  const server = createServer((req, res) => {
    void (async () => {
      const pathname = new URL(req.url, 'http://gateway.invalid').pathname
      if (await handleGatewayRoute(req, res, pathname)) return
      // Privileged methods never pass the gateway, token or not (read-only
      // exceptions per GATEWAY_READ_EXCEPTIONS).
      const method = pathname.startsWith('/api/') ? pathname.slice('/api/'.length).split('/')[0] : undefined
      if (method !== undefined && method !== '' && PRIVILEGED_METHODS.has(method)
        && !GATEWAY_READ_EXCEPTIONS.has(method)) {
        log(`blocked privileged method ${method} from ${req.socket.remoteAddress ?? '?'}`)
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('forbidden: privileged method over gateway')
        return
      }
      if (!isAuthed(state, req)) {
        if (pathname === '/api' || pathname.startsWith('/api/')) {
          sendJson(res, 401, { ok: false, error: 'unauthorized: pair at /mod-gateway/ first' })
        } else {
          res.writeHead(302, { location: GATEWAY_ROOT })
          res.end()
        }
        return
      }
      // Headers pass through verbatim — including the original Host header, so
      // the upstream browser-trust fence still sees the caller's authority.
      // Exception: the read-exempt methods (GATEWAY_READ_EXCEPTIONS) are the
      // web client's boot reads that the upstream fence pins to loopback even
      // for trusted hosts; the gateway has already authenticated the caller,
      // so for exactly these methods the request is presented to the upstream
      // as a loopback request (Host and Origin rewritten to the target).
      // Everything else keeps the original Host, and every mutating/secret
      // method remains blocked both here and upstream.
      let upstreamHeaders = req.headers
      if (method !== undefined && GATEWAY_READ_EXCEPTIONS.has(method)
        && (req.headers.host ?? '') !== `${target.host}:${target.port}`) {
        upstreamHeaders = {
          ...req.headers,
          host: `${target.host}:${target.port}`,
          ...(req.headers.origin === undefined ? {} : { origin: `http://${target.host}:${target.port}` }),
        }
      }
      const upstream = httpRequest(
        { host: target.host, port: target.port, method: req.method, path: req.url, headers: upstreamHeaders, agent: upstreamAgent },
        upRes => {
          if (pathname === '/api' || pathname.startsWith('/api/')) {
            log(`${req.method} ${pathname} -> ${String(upRes.statusCode)}`)
          }
          const contentType = String(upRes.headers['content-type'] ?? '')
          const injectDiag = diagEnabled
            && req.method === 'GET' && (upRes.statusCode ?? 0) === 200
            && contentType.includes('text/html')
            && upRes.headers['content-encoding'] === undefined
            && (pathname === '/' || pathname === '/index.html')
          if (injectDiag) {
            const chunks = []
            upRes.on('data', chunk => chunks.push(chunk))
            upRes.on('end', () => {
              const html = Buffer.concat(chunks).toString('utf8')
              const marker = '<head>'
              const at = html.toLowerCase().indexOf(marker)
              const injected = at >= 0
                ? `${html.slice(0, at + marker.length)}<script src="/mod-gateway/diag.js"></script>${html.slice(at + marker.length)}`
                : html
              const body = Buffer.from(injected, 'utf8')
              const headers = { ...upRes.headers, 'content-length': String(body.length), connection: 'close' }
              delete headers['transfer-encoding']
              delete headers['keep-alive']
              res.writeHead(upRes.statusCode ?? 200, headers)
              res.end(body)
            })
            return
          }
          // Answer proxied HTTP with Connection: close. Browsers cap HTTP/1.1
          // sockets per origin (6 in Chromium); on higher-latency paths (LAN
          // WiFi, Tailscale) the app's parallel RPC fetches hoard every slot
          // as idle keep-alives and the WebSocket event streams then starve
          // in the connect queue — the app's 3s readiness handshake times
          // out and the sidebar never loads. One-shot connections return the
          // slot after every response, so the streams always get one. The
          // upstream side keeps its own pooled keep-alive agent below.
          const closeHeaders = { ...upRes.headers, connection: 'close' }
          delete closeHeaders['keep-alive']
          res.writeHead(upRes.statusCode ?? 502, closeHeaders)
          upRes.pipe(res)
        },
      )
      upstream.on('error', error => {
        logError(`upstream ${target.host}:${target.port} request failed: ${String(error)}`)
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('gateway: upstream unavailable (is the DSH web server up?)')
      })
      req.pipe(upstream)
    })().catch(error => {
      logError(`request handling failed: ${String(error)}`)
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })

  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url, 'http://gateway.invalid').pathname
    if (diagEnabled) {
      log(`upgrade ${req.url} cookie=${req.headers.cookie !== undefined ? 'yes' : 'NO'} origin=${String(req.headers.origin ?? '-')} host=${String(req.headers.host ?? '-')}`)
    }
    if (pathname.startsWith(GATEWAY_ROOT) || pathname === '/mod-gateway') {
      socket.destroy()
      return
    }
    if (!isAuthed(state, req)) {
      if (diagEnabled) log(`upgrade DESTROYED unauth: ${req.url}`)
      socket.destroy()
      return
    }
    const upstream = netConnect(target.port, target.host, () => {
      // Replay the handshake verbatim (original Host included) then pipe both
      // directions; the Sec-WebSocket-* headers carry through untouched.
      let raw = `${req.method} ${req.url} HTTP/1.1\r\n`
      for (const [name, value] of Object.entries(req.headers)) {
        if (Array.isArray(value)) {
          for (const one of value) raw += `${name}: ${one}\r\n`
        } else {
          raw += `${name}: ${value}\r\n`
        }
      }
      raw += '\r\n'
      if (diagEnabled) {
        // Full handshake dump with the cookie value redacted; header names and
        // other values are needed to debug per-browser handshake differences.
        const redacted = raw.replace(/(cookie:[^\r\n]*)/i, match => match.replace(/=(.*)$/, '=<redacted>'))
        log(`upgrade relaying ${req.url}: ${String(raw.length)} bytes\n${redacted}`)
      }
      upstream.write(raw)
      if (head !== undefined && head.length > 0) upstream.write(head)
      let upstreamSentBytes = false
      upstream.on('data', chunk => {
        upstreamSentBytes = true
        if (diagEnabled && chunk.subarray(0, 4).toString('latin1') === 'HTTP') {
          // Response headers only; WS handshake responses carry no secrets.
          log(`upgrade upstream response ${req.url}:\n${chunk.subarray(0, 500).toString('latin1')}`)
        }
      })
      if (diagEnabled) {
        socket.on('close', hadError => log(`upgrade client closed ${req.url} (err=${String(hadError)}, upstreamResponded=${String(upstreamSentBytes)})`))
        upstream.on('close', () => log(`upgrade upstream closed ${req.url} (responded=${String(upstreamSentBytes)})`))
      }
      socket.pipe(upstream)
      upstream.pipe(socket)
    })
    upstream.on('error', error => {
      if (diagEnabled) log(`upgrade upstream error ${req.url}: ${String(error)}`)
      socket.destroy()
    })
    socket.on('error', () => upstream.destroy())
    upstream.on('close', () => socket.destroy())
  })

  server.on('error', error => {
    logError(`cannot serve on ${bind}:${port}: ${String(error)}`)
  })

  // Load (or create) the persisted state first so every logged pairing code is
  // the real one, then start listening. A failed state load aborts startup —
  // serving with an unknown token set would silently strand paired devices.
  void loadState(statePath)
    .then(loaded => {
      state = loaded
      // Optional operator-chosen pairing code (DSH_MOD_GATEWAY_CODE): a
      // memorable secret the owner can pair new devices with from anywhere.
      // Applied on every boot so changing it in the launcher takes effect on
      // restart; stored uppercase to match the case-insensitive compare.
      const chosen = env.DSH_MOD_GATEWAY_CODE
      if (typeof chosen === 'string' && chosen.trim() !== '' && chosen.trim().toUpperCase() !== state.pairingCode) {
        state.pairingCode = chosen.trim().toUpperCase()
      }
      return saveState(statePath, state)
    })
    .then(() => {
      server.listen(port, bind, () => {
        ready = true
        log(`remote access enabled: ${bind}:${port} -> ${target.host}:${target.port}`)
        for (const addr of lanIpv4Addresses()) log(`  http://${addr}:${port}/`)
        log(`  pairing code: ${formatCode(state.pairingCode)} (state: ${statePath})`)
      })
    })
    .catch(error => logError(`cannot start: ${String(error)}`))

  return () => {
    if (ready) log('shutting down')
    server.close()
    server.closeAllConnections?.()
    upstreamAgent.destroy()
  }
}
