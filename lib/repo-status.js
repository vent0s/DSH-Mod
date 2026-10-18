import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, open, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

export const REPO_CONFIG_FILE = '.dsh-repos.json'
const defaults = { version: 1, repos: [], autoFetch: true, localIntervalSeconds: 60, fetchIntervalSeconds: 300 }
const failure = message => { throw new Error(message) }
const inside = (root, path) => {
  const rel = relative(root, path)
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

export function validateRepoConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) failure('仓库配置必须是 JSON 对象')
  const config = { ...defaults, ...input }
  if (Object.keys(input).some(key => !Object.hasOwn(defaults, key))) failure('仓库配置包含未知字段')
  if (config.version !== 1 || !Array.isArray(config.repos) || config.repos.length > 32) failure('配置版本必须为 1，最多跟踪 32 个仓库')
  config.repos = [...new Set(config.repos.map(path => {
    if (typeof path !== 'string' || !path.trim() || path.length > 1024 || /[\0\r\n]/.test(path)) failure('请填写有效的相对路径，一行一个仓库')
    path = path.trim()
    if (isAbsolute(path) || /^[A-Za-z]:/.test(path) || path.includes('\\') || path.split('/').includes('..')) failure('仓库路径必须位于工作区内，使用相对路径和 /')
    return path
  }))]
  if (typeof config.autoFetch !== 'boolean') failure('autoFetch 必须为布尔值')
  for (const [key, min, max] of [['localIntervalSeconds', 30, 3600], ['fetchIntervalSeconds', 300, 86400]]) {
    if (!Number.isInteger(config[key]) || config[key] < min || config[key] > max) failure(`${key} 必须在 ${min}–${max} 秒之间`)
  }
  return config
}

async function readConfig(root) {
  let file
  try {
    if ((await lstat(join(root, REPO_CONFIG_FILE))).isSymbolicLink()) failure('配置文件不能是符号链接')
    file = await open(join(root, REPO_CONFIG_FILE), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const info = await file.stat()
    if (!info.isFile() || info.size > 65536) failure('仓库配置必须是小于 64 KiB 的普通文件')
    const raw = await file.readFile('utf8')
    if (Buffer.byteLength(raw) > 65536) failure('仓库配置必须小于 64 KiB')
    return { config: validateRepoConfig(JSON.parse(raw)), revision: createHash('sha256').update(raw).digest('hex') }
  } catch (error) {
    if (error.code === 'ENOENT') return { config: { ...defaults, repos: [] }, revision: 'missing' }
    if (error instanceof SyntaxError) failure('无法解析 .dsh-repos.json，请检查 JSON 格式')
    throw error
  } finally { await file?.close() }
}

/** Porcelain v2 -z: rename records consume a second NUL-delimited path. */
export function parseRepoStatus(output) {
  const result = { branch: null, upstream: null, ahead: null, behind: null, dirty: 0, detached: false, unborn: false }
  const records = output.split('\0')
  for (let i = 0; i < records.length; i++) {
    const line = records[i]
    if (line.startsWith('# branch.head ')) {
      result.branch = line.slice(14)
      result.detached = result.branch === '(detached)'
    } else if (line.startsWith('# branch.oid ')) result.unborn = line.slice(13) === '(initial)'
    else if (line.startsWith('# branch.upstream ')) result.upstream = line.slice(18)
    else if (line.startsWith('# branch.ab ')) {
      const match = /^# branch.ab \+(\d+) -(\d+)$/.exec(line)
      if (match) { result.ahead = Number(match[1]); result.behind = Number(match[2]) }
    } else if (/^(1 |2 |u |\? )/.test(line)) {
      result.dirty++
      if (line.startsWith('2 ')) i++
    }
  }
  return result
}

/** Bounded process pool shared by every workspace and browser using this plugin. */
function gitPool() {
  const pending = [], running = new Set()
  let closed = false
  function pump() {
    while (!closed && running.size < 2 && pending.length) {
      const job = pending.shift()
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
      Object.assign(env, { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', GIT_SSH_COMMAND: 'ssh -oBatchMode=yes -oConnectTimeout=10', LC_ALL: 'C' })
      const child = spawn('git', ['--no-optional-locks', '-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`, ...job.args], {
        cwd: job.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32',
      })
      let output = [], bytes = 0, reason
      const kill = message => {
        reason = message
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL')
          else child.kill('SIGKILL')
        } catch { child.kill('SIGKILL') }
      }
      running.add(kill)
      const timer = setTimeout(() => kill('Git 检查超时，请稍后重试'), job.timeout)
      for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
        bytes += chunk.length
        if (bytes > 2 * 1024 * 1024) kill('Git 输出超过 2 MiB，请缩小仓库中的未跟踪文件范围')
        else if (stream === child.stdout) output.push(chunk)
      })
      child.on('error', () => { reason = '无法启动 Git，请确认 Git 已安装' })
      child.on('close', code => {
        clearTimeout(timer); running.delete(kill)
        if (reason || code !== 0) job.reject(new Error(reason || 'Git 检查失败，请检查仓库、远端连接及凭据'))
        else job.resolve(Buffer.concat(output).toString('utf8'))
        output = []; pump()
      })
    }
  }
  return {
    run(cwd, args, timeout = 10000) {
      if (closed || pending.length >= 128) return Promise.reject(new Error('仓库检查暂不可用'))
      return new Promise((resolve, reject) => { pending.push({ cwd, args, timeout, resolve, reject }); pump() })
    },
    dispose() {
      closed = true
      for (const job of pending.splice(0)) job.reject(new Error('插件已卸载'))
      for (const kill of running) kill('插件已卸载')
    },
  }
}

export function createRepoMonitor({ getWorkspace, now = Date.now, runGit } = {}) {
  const pool = gitPool(), git = runGit ?? pool.run
  const workspaces = new Map(), repos = new Map()
  let disposed = false
  function stateFor(map, key, limit) {
    let state = map.get(key)
    if (!state) {
      if (map.size >= limit) {
        const idle = [...map].find(([, value]) => !value.pending)
        if (!idle) failure('同时检查的工作区过多，请稍后重试')
        map.delete(idle[0])
      }
      map.set(key, state = {})
    }
    return state
  }
  async function repoPath(root, path) {
    const candidate = resolve(root, path)
    if (!inside(root, candidate)) failure('仓库路径超出工作区')
    const canonical = await realpath(candidate)
    if (!inside(root, canonical)) failure('仓库符号链接指向工作区外')
    // Require the configured path itself to be a root, not an arbitrary child.
    const top = (await git(canonical, ['rev-parse', '--show-toplevel'])).trimEnd()
    if (await realpath(top) !== canonical) failure('请填写 Git 仓库根目录，而不是仓库的子目录')
    return canonical
  }
  async function inspect(path, config, force) {
    const state = stateFor(repos, path, 256)
    if (state.pending) return state.pending
    const localMs = (force ? 5 : config.localIntervalSeconds) * 1000
    if (state.value && now() - state.checkedAt < localMs
      && (!config.autoFetch || now() - (state.attemptAt ?? -Infinity) < config.fetchIntervalSeconds * 1000)) return state.value
    state.pending = (async () => {
      const statusArgs = ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal']
      let result = parseRepoStatus(await git(path, statusArgs))
      const key = `${result.branch}:${result.upstream}`
      if (state.branchKey !== key) {
        state.branchKey = key; state.attemptAt = undefined; state.fetchedAt = undefined; state.fetchError = undefined
      }
      if (config.autoFetch && result.upstream && !result.detached && !result.unborn
        && now() - (state.attemptAt ?? -Infinity) >= config.fetchIntervalSeconds * 1000) {
        state.attemptAt = now()
        try {
          const remote = (await git(path, ['config', '--get', `branch.${result.branch}.remote`])).trim()
          if (!remote || remote.startsWith('-')) failure('未找到有效的上游远端')
          if (remote !== '.') await git(path, ['fetch', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--no-auto-maintenance', '--', remote], 30000)
          state.fetchedAt = now(); state.fetchError = undefined
        } catch (error) { state.fetchError = error.message }
        result = parseRepoStatus(await git(path, statusArgs))
      }
      state.checkedAt = now()
      state.value = { ...result, checkedAt: state.checkedAt, fetchAttemptAt: state.attemptAt ?? null, fetchedAt: state.fetchedAt ?? null, fetchError: state.fetchError ?? null }
      return state.value
    })().finally(() => { state.pending = undefined })
    return state.pending
  }
  async function status(root, snapshot, state, force) {
    if (state.value && state.revision === snapshot.revision
      && now() - state.checkedAt < (force ? 5000 : snapshot.config.localIntervalSeconds * 1000)) return state.value
    const results = await Promise.all(snapshot.config.repos.map(async path => {
      try { return { path, ...await inspect(await repoPath(root, path), snapshot.config, force) } }
      catch (error) { return { path, error: error.code ? '仓库目录不可访问或不存在' : error.message } }
    }))
    state.checkedAt = now(); state.revision = snapshot.revision
    return state.value = { ...snapshot, repos: results, checkedAt: state.checkedAt, configFile: REPO_CONFIG_FILE }
  }
  async function save(root, payload) {
    const config = validateRepoConfig(payload.config)
    for (const path of config.repos) await repoPath(root, path)
    const current = await readConfig(root)
    if (payload.revision !== current.revision) failure('配置已被 agent 或其他页面修改，请重新加载后保存')
    const target = join(root, REPO_CONFIG_FILE)
    try { if ((await lstat(target)).isSymbolicLink()) failure('配置文件不能是符号链接') } catch (error) { if (error.code !== 'ENOENT') throw error }
    const temp = join(root, `${REPO_CONFIG_FILE}.${randomUUID()}.tmp`)
    try {
      await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
      await rename(temp, target)
    } finally { await unlink(temp).catch(() => {}) }
    return readConfig(root)
  }
  return {
    async handle(endpoint, payload) {
      try {
        if (disposed) failure('插件已卸载')
        if (!['status', 'save'].includes(endpoint)) failure('未知仓库操作')
        if (!payload || typeof payload.workspaceId !== 'string') failure('缺少工作区 ID')
        const workspace = getWorkspace(payload.workspaceId)
        if (!workspace) failure('工作区不存在')
        const root = await realpath(workspace.path)
        const state = stateFor(workspaces, root, 64)
        // Serialize writes and share status work across sessions and tabs.
        if (state.pending) {
          const previous = await state.pending
          if (endpoint === 'status' && previous?.repos) return { ok: true, value: previous }
          return this.handle(endpoint, payload)
        }
        state.pending = (async () => {
          if (endpoint === 'save') {
            const snapshot = await save(root, payload)
            state.value = undefined
            return snapshot
          }
          return status(root, await readConfig(root), state, payload.refresh === true)
        })()
        try { return { ok: true, value: await state.pending } }
        finally { state.pending = undefined }
      } catch (error) {
        return { ok: false, error: { code: 'repo-status-failed', message: error.code ? '无法读取工作区仓库配置或目录' : error.message, details: {} } }
      }
    },
    dispose() { disposed = true; pool.dispose(); workspaces.clear(); repos.clear() },
  }
}
