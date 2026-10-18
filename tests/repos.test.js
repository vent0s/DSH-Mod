import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRepoMonitor, parseRepoStatus, REPO_CONFIG_FILE, validateRepoConfig } from '../lib/repo-status.js'
import { apply } from '../lib/index.js'

const exec = promisify(execFile)
const git = async (cwd, ...args) => (await exec('git', args, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } })).stdout.trim()
async function fixture(t, config = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-repos-'))
  let clock = 1_000_000
  const monitor = createRepoMonitor({ getWorkspace: id => id === 'ws' ? { path: root } : undefined, now: () => clock })
  t.after(async () => { monitor.dispose(); await rm(root, { recursive: true, force: true }) })
  const configuration = { version: 1, repos: [], autoFetch: false, ...config }
  await writeFile(join(root, REPO_CONFIG_FILE), JSON.stringify(configuration))
  async function repo(name) {
    const path = join(root, name); await mkdir(path)
    await git(path, 'init', '-b', 'main')
    await git(path, 'config', 'user.email', 'test@example.invalid')
    await git(path, 'config', 'user.name', 'Fixture')
    return path
  }
  async function commit(path, name = 'file.txt') {
    await writeFile(join(path, name), String(clock++))
    await git(path, 'add', '.'); await git(path, 'commit', '-m', 'fixture')
  }
  const call = (endpoint = 'status', extra = {}) => monitor.handle(endpoint, { workspaceId: 'ws', ...extra })
  const status = async (refresh = false) => { const result = await call('status', { refresh }); assert.equal(result.ok, true, result.error?.message); return result.value }
  return { root, monitor, repo, commit, call, status, advance: ms => { clock += ms } }
}

test('porcelain parser consumes renamed paths safely, including newlines and header-like names', () => {
  const result = parseRepoStatus('# branch.oid abc\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -3\0'
    + '2 R. N... 100644 100644 100644 a b R100 new\0? fake\npath\0? real\0u UU conflict\0')
  assert.deepEqual(result, { branch: 'main', upstream: 'origin/main', ahead: 2, behind: 3, dirty: 3, detached: false, unborn: false })
})

test('real Git: staged, unstaged, untracked, unborn, detached and no upstream', async t => {
  const f = await fixture(t, { repos: ['repo with spaces', 'empty'] })
  const path = await f.repo('repo with spaces'); await f.repo('empty'); await f.commit(path)
  await writeFile(join(path, 'file.txt'), 'modified')
  await writeFile(join(path, 'staged'), 'staged'); await git(path, 'add', 'staged')
  await writeFile(join(path, 'untracked'), 'untracked')
  let value = await f.status()
  assert.equal(value.repos[0].dirty, 3); assert.equal(value.repos[0].ahead, null)
  assert.equal(value.repos[1].unborn, true)
  await git(path, 'checkout', '--detach'); f.advance(60000)
  value = await f.status(); assert.equal(value.repos[0].detached, true)
})

test('real Git: fetch detects behind/divergence without changing HEAD or the worktree, failure retains old counts', async t => {
  const f = await fixture(t, { repos: ['local'], autoFetch: true })
  const remote = join(f.root, 'remote.git'); await git(f.root, 'init', '--bare', remote)
  const local = await f.repo('local'); await f.commit(local)
  await git(local, 'remote', 'add', 'origin', remote); await git(local, 'push', '-u', 'origin', 'main')
  const peer = await f.repo('peer'); await git(peer, 'remote', 'add', 'origin', remote)
  await git(peer, 'fetch', 'origin'); await git(peer, 'reset', '--hard', 'origin/main')
  await f.commit(peer, 'from-peer'); await git(peer, 'push', 'origin', 'main')
  await f.commit(local, 'local-only')
  const head = await git(local, 'rev-parse', 'HEAD')
  let value = await f.status()
  assert.equal(value.repos[0].ahead, 1); assert.equal(value.repos[0].behind, 1)
  assert.ok(value.repos[0].fetchedAt); assert.equal(value.repos[0].fetchError, null)
  assert.equal(await git(local, 'rev-parse', 'HEAD'), head)
  assert.equal(await git(local, 'status', '--porcelain'), '')
  await git(local, 'remote', 'set-url', 'origin', join(f.root, 'missing'))
  f.advance(300001); value = await f.status()
  assert.match(value.repos[0].fetchError, /失败/)
  assert.equal(value.repos[0].behind, 1)
  assert.ok(value.repos[0].fetchAttemptAt > value.repos[0].fetchedAt)
})

test('confined roots: reject traversal, symlink escape and child directories; support nested repo and worktree', async t => {
  const f = await fixture(t, { repos: ['repo', 'repo/sub', 'escape', 'worktree'] })
  const path = await f.repo('repo'); await f.commit(path); await mkdir(join(path, 'sub'))
  await symlink(tmpdir(), join(f.root, 'escape'))
  await git(path, 'worktree', 'add', '-b', 'worktree', join(f.root, 'worktree'))
  const value = await f.status()
  assert.equal(value.repos[0].dirty, 0)
  assert.match(value.repos[1].error, /根目录/)
  assert.match(value.repos[2].error, /工作区外/)
  assert.equal(value.repos[3].branch, 'worktree')
  for (const path of ['../outside', '/absolute', 'C:/outside', '..\\outside']) assert.throws(() => validateRepoConfig({ repos: [path] }), /相对路径/)
  assert.throws(() => validateRepoConfig({ repos: ['.'], fetchIntervalSeconds: 1 }), /300/)
  assert.throws(() => validateRepoConfig({ repos: Array(33).fill('.') }), /32/)
  assert.equal((await f.call('status', { workspaceId: 'unknown' })).ok, false)
})

test('configuration save validates paths and protects agent edits; status isolates a missing repo', async t => {
  const f = await fixture(t, { repos: ['repo', 'missing'] }); await f.repo('repo')
  let value = await f.status(); assert.ok(value.repos[1].error)
  const updated = { ...value.config, repos: ['repo'] }
  let saved = await f.call('save', { config: updated, revision: value.revision }); assert.equal(saved.ok, true)
  assert.deepEqual(JSON.parse(await readFile(join(f.root, REPO_CONFIG_FILE))), updated)
  assert.equal((await f.call('save', { config: updated, revision: value.revision })).ok, false)
  value = await f.status()
  assert.equal((await f.call('save', { config: { ...updated, repos: ['absent'] }, revision: value.revision })).ok, false)
  assert.deepEqual(JSON.parse(await readFile(join(f.root, REPO_CONFIG_FILE))), updated)
  await writeFile(join(f.root, REPO_CONFIG_FILE), '{broken')
  assert.match((await f.call()).error.message, /JSON/)
})

test('configuration symlink cannot read or overwrite another file', async t => {
  const f = await fixture(t)
  const target = join(f.root, 'elsewhere'); await writeFile(target, '{"repos":[]}')
  await rm(join(f.root, REPO_CONFIG_FILE)); await symlink(target, join(f.root, REPO_CONFIG_FILE))
  assert.equal((await f.call()).ok, false)
  assert.equal(await readFile(target, 'utf8'), '{"repos":[]}')
})

test('shared caches coalesce parallel calls; forced refresh and failed fetch obey independent rate limits', async t => {
  const f = await fixture(t, { repos: ['repo'], autoFetch: true }); const path = await f.repo('repo')
  let clock = 1_000_000, statuses = 0, fetches = 0
  const monitor = createRepoMonitor({ getWorkspace: () => ({ path: f.root }), now: () => clock,
    runGit: async (cwd, args) => {
      await new Promise(resolve => setImmediate(resolve))
      if (args[0] === 'rev-parse') return path
      if (args[0] === 'config') return 'origin'
      if (args[0] === 'fetch') { fetches++; throw new Error('offline') }
      statuses++
      return '# branch.head main\0# branch.upstream origin/main\0# branch.ab +1 -0\0'
    },
  }); t.after(() => monitor.dispose())
  const get = () => monitor.handle('status', { workspaceId: 'ws', refresh: true })
  const values = await Promise.all(Array.from({ length: 10 }, get))
  assert.ok(values.every(value => value.ok))
  assert.equal(fetches, 1); assert.equal(statuses, 2)
  await get(); assert.equal(statuses, 2)
  clock += 5001; await get(); assert.equal(statuses, 3); assert.equal(fetches, 1)
  clock += 300000; await get(); assert.equal(fetches, 2)
  monitor.dispose(); assert.equal((await get()).ok, false)
})

test('host routes resolve registered workspace IDs and clean up, feature can be disabled', async t => {
  const f = await fixture(t)
  for (const enabled of [false, true]) {
    const routes = new Map(), effects = []
    const oldPort = process.env.DSH_MOD_GATEWAY_PORT; delete process.env.DSH_MOD_GATEWAY_PORT
    try {
      apply({ workspaceRegistry: { get: id => id === 'ws' ? { path: f.root } : undefined },
        connection: { rpc: { handle: (channel, handler) => { routes.set(channel, handler); return () => routes.delete(channel) } } },
        effect: factory => effects.push(factory()),
      }, { repoStatus: enabled })
    } finally { if (oldPort !== undefined) process.env.DSH_MOD_GATEWAY_PORT = oldPort }
    assert.equal(routes.has('/mod-repos'), enabled)
    if (enabled) {
      assert.equal((await routes.get('/mod-repos')('status', { workspaceId: 'ws', path: '/ignored' })).ok, true)
      assert.equal((await routes.get('/mod-repos')('status', { workspaceId: 'unknown', path: f.root })).ok, false)
    }
    for (const dispose of effects) await dispose()
    assert.equal(routes.size, 0)
  }
})
