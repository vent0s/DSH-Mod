import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(process.env.DSH_HARNESS_ROOT ?? '../deepseek-harness-latest')
const plugin = fileURLToPath(new URL('..', import.meta.url))
const requireCli = createRequire(join(root, 'apps/cli/package.json'))
const requireWeb = createRequire(join(root, 'apps/web/package.json'))
const { chromium } = requireWeb('playwright')

test('shipped web profile: repository RPC, header, persisted configuration and narrow-screen bounds', { timeout: 60000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-repos-browser-'))
  let browser, child
  t.after(async () => {
    await browser?.close()
    if (child && child.exitCode === null) { const closed = once(child, 'close'); child.kill('SIGTERM'); await closed }
    await rm(home, { recursive: true, force: true })
  })
  const profile = join(home, 'profiles/web')
  await mkdir(join(profile, 'node_modules/@vent0s'), { recursive: true })
  await symlink(plugin, join(profile, 'node_modules/@vent0s/dsh-mod-workspace-files'), 'dir')
  await writeFile(join(home, 'package.json'), '{"private":true}\n')
  await writeFile(join(profile, 'package.json'), JSON.stringify({ private: true, dsh: { profile: {
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@vent0s/dsh-mod-workspace-files'],
  } } }))
  await writeFile(join(profile, 'cordis.yml'), '[]\n')
  await writeFile(join(profile, 'cordis.patch.yml'), '[]\n')
  const workspace = join(home, 'workspace')
  await mkdir(join(workspace, 'example'), { recursive: true })
  execFileSync('git', ['init', '-b', 'main'], { cwd: join(workspace, 'example'), stdio: 'ignore' })
  await writeFile(join(workspace, 'example/new.txt'), 'fixture')
  await writeFile(join(workspace, '.dsh-repos.json'), JSON.stringify({ version: 1, repos: ['example'], autoFetch: false }))
  const { Context } = requireCli('@deepseek-ai/cordis')
  const seeder = new Context()
  try {
    await seeder.plugin(requireCli('@deepseek-ai/dsh-session-persistence-jsonl'), { root: join(home, 'sessions') })
    const time = Date.now()
    const handle = await seeder.sessionPersistence.create({ version: 4, id: 'repo-ui-fixture', createdAt: time, cwd: await realpath(workspace), isSeeded: false, agentPreset: 'standard' })
    await handle.append([
      { seq: 0, time, type: 'turn/start', data: { turn: 1 } },
      { seq: 1, time: time + 1, type: 'user/message', surfaceOp: 'append', data: { id: 'user-fixture', role: 'user', content: [{ type: 'text', text: 'Repo fixture' }], source: { kind: 'user' } } },
      { seq: 2, time: time + 2, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      { seq: 3, time: time + 3, type: 'session/title', data: { title: 'Repo fixture', messageSeqs: [], source: { kind: 'user' } } },
    ])
    await handle.close()
  } finally { await seeder.fiber.dispose() }
  const env = { ...process.env, DSH_HOME: home }
  delete env.DSH_MOD_GATEWAY_PORT
  child = spawn(process.execPath, ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web', '--port', '0', '--no-open'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const url = await new Promise((resolve, reject) => {
    let log = ''
    const timer = setTimeout(() => reject(new Error('Isolated DSH startup timed out')), 20000)
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
      log = (log + chunk).slice(-20000)
      const match = log.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/)
      if (match) { clearTimeout(timer); resolve(match[0]) }
    })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`DSH exited: ${code}`)) })
  })
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1280, height: 900 } })
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  await page.goto(url)
  await page.getByRole('button', { name: '继续', exact: true }).click({ timeout: 10000 })
  await page.getByRole('dialog', { name: '开始使用', exact: true }).waitFor()
  await page.keyboard.press('Escape')
  await page.getByRole('dialog', { name: '开始使用', exact: true }).waitFor({ state: 'hidden' })
  await page.getByText(/^(未命名|Repo fixture)$/).first().click({ timeout: 10000 })
  const trigger = page.getByRole('button', { name: /^工作区仓库:/ })
  await trigger.waitFor()
  await trigger.click()
  const panel = page.locator('.dsh-mod-repo-panel')
  const input = panel.locator('textarea')
  await input.waitFor()
  assert.equal(await input.inputValue(), 'example')
  assert.match(await trigger.textContent(), /✎1/)
  await panel.getByRole('button', { name: '保存仓库配置', exact: true }).click()
  await panel.getByRole('button', { name: '保存仓库配置', exact: true }).waitFor()
  await page.waitForFunction(() => !document.querySelector('.dsh-mod-repo-panel textarea').disabled)
  assert.deepEqual(JSON.parse(await readFile(join(workspace, '.dsh-repos.json'), 'utf8')).repos, ['example'])
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 })
    await page.waitForFunction(() => {
      const rect = document.querySelector('.dsh-mod-repo-panel').getBoundingClientRect()
      return rect.left >= 0 && rect.right <= innerWidth
    })
    const box = await panel.boundingBox()
    assert.ok(box.x >= 0 && box.x + box.width <= width)
    if (process.env.DSH_REPO_SCREENSHOTS) {
      await mkdir(process.env.DSH_REPO_SCREENSHOTS, { recursive: true })
      await page.screenshot({ path: join(process.env.DSH_REPO_SCREENSHOTS, `repo-status-${width}.png`) })
    }
  }
  assert.deepEqual(errors, [])
})
