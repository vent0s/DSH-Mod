import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve, join } from 'node:path'
import { runInNewContext } from 'node:vm'

const root = resolve(process.env.DSH_HARNESS_ROOT ?? '../deepseek-harness')
const requireRoot = createRequire(join(root, 'package.json'))
const requireWeb = createRequire(join(root, 'apps/web/package.json'))
const { JSDOM } = requireRoot('jsdom')
const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
const React = requireWeb('react')
const { render, fireEvent, cleanup } = requireRoot('@testing-library/react')
const { act } = React
const initial = () => ({ revision: 'one', config: { version: 1, repos: ['a', 'b'], autoFetch: true, localIntervalSeconds: 60, fetchIntervalSeconds: 300 }, repos: [
  { path: 'a', branch: 'main', upstream: 'origin/main', dirty: 2, ahead: 3, behind: 1, checkedAt: Date.now(), fetchedAt: Date.now() },
  { path: 'b', branch: 'main', upstream: null, dirty: 0, ahead: null, behind: null, checkedAt: Date.now(), fetchedAt: null },
] })

async function mount(t, options = {}) {
  let client, dictionary, Component, entry, nextTimer = 0, hidden = false
  const timers = new Map(), calls = []
  const workspaces = [{ workspaceId: 'first', title: 'first-workspace', sessionIds: ['session1'] }, { workspaceId: 'second', title: 'second-workspace', sessionIds: ['session2'] }]
  Object.defineProperty(document, 'hidden', { get: () => hidden, configurable: true })
  window.__ModuleLoader__ = { load: ({ factory }) => { client = factory(name => name === 'react' ? React : {}) } }
  runInNewContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), {
    window, document, AbortController, console,
    setTimeout: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, delay }); return id }, clearTimeout: id => timers.delete(id),
  })
  const services = {
    locale: { register: (_ns, dictionaries) => { dictionary = dictionaries.zh; return () => {} } },
    slots: { inject: (_name, callback) => callback(), register: (registration, component) => {
      if (registration.id === 'dsh-mod-repos' && registration.name === (options.slot ?? 'conversation.session.header.actions')) { entry = registration; Component = component }
    } },
    connection: { isLoopback: false, rpc: { call: async (channel, endpoint, payload, signal) => {
      assert.equal(channel, '/mod-repos'); calls.push({ endpoint, payload, signal })
      return options.call ? options.call(endpoint, payload, signal) : { ok: true, value: initial() }
    } } },
  }
  client.apply({ get: name => services[name], effect: fn => fn(), on: () => {} }, { hashFileSearch: false, openWorkspaceFolder: false, repoStatus: options.enabled !== false })
  t.after(cleanup)
  if (!Component) return { calls, entry }
  const props = { ...entry.inject(), t: key => dictionary[key], useWorkspaces: selector => selector({ items: workspaces }), sessionId: 'session1' }
  let view
  await act(async () => { view = render(React.createElement(Component, props)) })
  return { view, calls, timers, props, Component,
    open: () => fireEvent.click(view.getByRole('button', { name: /^工作区仓库/ })),
    edit: () => { if (!view.queryByRole('textbox')) fireEvent.click(view.getByRole('button', { name: '管理仓库' })) },
    settings: () => { const summary = view.getByText('检查设置与时间'); if (!summary.closest('details').open) fireEvent.click(summary) },
    visibility: async value => { hidden = value; await act(async () => document.dispatchEvent(new window.Event('visibilitychange'))) },
  }
}

test('header icons and per-repo details distinguish pending commits, missing upstream and fetch errors', async t => {
  const f = await mount(t, { call: async () => { const value = initial(); value.repos[0].fetchError = 'offline'; return { ok: true, value } } })
  const button = f.view.getByRole('button', { name: /^工作区仓库/ })
  assert.match(button.textContent, /✎2 ↑3 ↓1 \? !/)
  f.open()
  assert.match(f.view.container.textContent, /未设置上游/)
  assert.match(f.view.container.textContent, /远端检查失败/)
  assert.doesNotMatch(f.view.container.textContent, /本地检查/)
  f.edit(); f.settings()
  assert.match(f.view.container.textContent, /本地检查/)
  fireEvent.keyDown(document, { key: 'Escape' })
  assert.equal(button.getAttribute('aria-expanded'), 'false')
})

test('save supports multiple relative paths, preserves intervals and exposes rejected writes', async t => {
  const f = await mount(t, { call: async endpoint => endpoint === 'status' ? { ok: true, value: initial() } : { ok: false, error: { message: '配置已被 agent 修改' } } })
  f.open(); f.edit(); f.settings()
  fireEvent.change(f.view.getByRole('textbox'), { target: { value: 'a\nfolder/repo\n\n' } })
  fireEvent.click(f.view.getByRole('checkbox'))
  await act(async () => fireEvent.click(f.view.getByRole('button', { name: '保存仓库配置' })))
  const saved = f.calls.find(call => call.endpoint === 'save').payload
  assert.deepEqual(Array.from(saved.config.repos), ['a', 'folder/repo'])
  assert.equal(saved.config.autoFetch, false); assert.equal(saved.config.localIntervalSeconds, 60)
  assert.equal(saved.revision, 'one')
  assert.match(f.view.getByRole('alert').textContent, /agent/)
  assert.equal(f.view.getByRole('textbox').value, 'a\nfolder/repo\n\n')
})

test('blank-session workspace row exposes a labelled repository editor before the first message', async t => {
  let value = { ...initial(), repos: [], config: { ...initial().config, repos: [] } }
  const f = await mount(t, { slot: 'conversation.hero.options', call: async (endpoint, payload) => {
    if (endpoint === 'save') value = { ...value, revision: 'two', config: payload.config }
    return { ok: true, value }
  } })
  assert.match(f.view.getByRole('button', { name: /^工作区仓库/ }).textContent, /仓库.*▾/)
  f.open(); f.edit()
  fireEvent.change(f.view.getByRole('textbox'), { target: { value: '.\npackages/helper' } })
  await act(async () => fireEvent.click(f.view.getByRole('button', { name: '保存仓库配置' })))
  const saved = f.calls.find(call => call.endpoint === 'save').payload
  assert.equal(saved.workspaceId, 'first')
  assert.deepEqual(Array.from(saved.config.repos), ['.', 'packages/helper'])
  assert.equal(f.view.getByRole('textbox').value, '.\npackages/helper')
})

test('polling uses 60-second timer, pauses while hidden, coalesces focus and aborts on unmount', async t => {
  const f = await mount(t)
  assert.equal(f.calls.length, 1); assert.equal(f.timers.size, 1)
  assert.equal([...f.timers.values()][0].delay, 60000)
  await f.visibility(true); assert.equal(f.timers.size, 0)
  await act(async () => window.dispatchEvent(new window.Event('focus'))); assert.equal(f.calls.length, 1)
  await f.visibility(false); assert.equal(f.calls.length, 2)
  f.view.unmount(); assert.equal(f.timers.size, 0)
  await act(async () => window.dispatchEvent(new window.Event('focus'))); assert.equal(f.calls.length, 2)
})

test('workspace switching cancels stale requests and does not show previous workspace results', async t => {
  let finish
  const f = await mount(t, { call: (endpoint, payload) => payload.workspaceId === 'first'
    ? new Promise(resolve => { finish = resolve })
    : Promise.resolve({ ok: true, value: { ...initial(), repos: [] } }) })
  await act(async () => f.view.rerender(React.createElement(f.Component, { ...f.props, sessionId: 'session2' })))
  assert.equal(f.calls[0].signal.aborted, true)
  await act(async () => finish({ ok: true, value: initial() }))
  assert.match(f.view.getByRole('button').getAttribute('aria-label'), /尚未配置仓库/)
  assert.equal(f.calls[1].payload.workspaceId, 'second')
})

test('successful save reloads persisted paths; background polling never replaces an unfinished draft', async t => {
  let value = initial()
  const f = await mount(t, { call: async (endpoint, payload) => {
    if (endpoint === 'save') value = { ...value, revision: 'two', config: payload.config, repos: [] }
    return { ok: true, value }
  } })
  f.open(); f.edit(); fireEvent.change(f.view.getByRole('textbox'), { target: { value: 'new-repo' } })
  await act(async () => fireEvent.click(f.view.getByRole('button', { name: '刷新状态' })))
  assert.equal(f.view.getByRole('textbox').value, 'new-repo')
  await act(async () => fireEvent.click(f.view.getByRole('button', { name: '保存仓库配置' })))
  assert.equal(f.view.getByRole('textbox').value, 'new-repo')
  assert.equal(f.calls.at(-1).endpoint, 'status')
  assert.equal(f.view.queryByRole('alert'), null)
})

test('agent configuration changes update an untouched editor on the next background check', async t => {
  let value = { ...initial(), revision: 'missing', config: { ...initial().config, repos: [] }, repos: [] }
  const f = await mount(t, { call: async () => ({ ok: true, value }) })
  f.open()
  assert.equal(f.view.getByRole('textbox').value, '')
  value = { ...initial(), revision: 'agent-written', config: { ...initial().config, repos: ['.'], autoFetch: false }, repos: [initial().repos[0]] }
  await act(async () => window.dispatchEvent(new window.Event('focus')))
  f.edit(); f.settings()
  assert.equal(f.view.getByRole('textbox').value, '.')
  assert.equal(f.view.getByRole('checkbox').checked, false)
  assert.equal(f.view.getByRole('button', { name: '保存仓库配置' }).disabled, false)
  assert.doesNotMatch(f.view.container.textContent, /配置已在其他位置修改/)
})

test('external configuration changes preserve real edits until reload, but reverted edits can follow the file', async t => {
  let value = initial()
  const f = await mount(t, { call: async () => ({ ok: true, value }) })
  f.open(); f.edit(); f.settings()
  fireEvent.change(f.view.getByRole('textbox'), { target: { value: 'my-unfinished-repo' } })
  value = { ...value, revision: 'agent-written', config: { ...value.config, repos: ['agent-repo'] } }
  await act(async () => window.dispatchEvent(new window.Event('focus')))
  assert.equal(f.view.getByRole('textbox').value, 'my-unfinished-repo')
  assert.equal(f.view.getByRole('button', { name: '保存仓库配置' }).disabled, true)
  assert.match(f.view.container.textContent, /配置已在其他位置修改/)
  await act(async () => fireEvent.click(f.view.getByRole('button', { name: '重新加载配置' })))
  assert.equal(f.view.getByRole('textbox').value, 'agent-repo')
  fireEvent.change(f.view.getByRole('textbox'), { target: { value: 'temporary' } })
  fireEvent.change(f.view.getByRole('textbox'), { target: { value: 'agent-repo' } })
  fireEvent.click(f.view.getByRole('checkbox'))
  fireEvent.click(f.view.getByRole('checkbox'))
  value = { ...value, revision: 'agent-written-again', config: { ...value.config, repos: ['latest-repo'] } }
  await act(async () => window.dispatchEvent(new window.Event('focus')))
  assert.equal(f.view.getByRole('textbox').value, 'latest-repo')
  assert.equal(f.view.getByRole('button', { name: '保存仓库配置' }).disabled, false)
})

test('overview names the root repository and keeps configuration and check details collapsed', async t => {
  const value = { ...initial(), config: { ...initial().config, repos: ['.'] }, repos: [{ ...initial().repos[0], path: '.', dirty: 1, ahead: 0, behind: 0 }] }
  const f = await mount(t, { call: async () => ({ ok: true, value }) })
  assert.match(f.view.getByRole('button', { name: /^工作区仓库/ }).textContent, /仓库 ✎1 ▾/)
  f.open()
  assert.match(f.view.container.textContent, /first-workspace/)
  assert.match(f.view.container.textContent, /✎1 未提交/)
  assert.equal(f.view.queryByRole('textbox'), null)
  assert.doesNotMatch(f.view.container.textContent, /本地检查|\.dsh-repos\.json|检查间隔/)
  f.edit()
  assert.equal(f.view.getByRole('textbox').value, '.')
  assert.equal(f.view.getByText('检查设置与时间').closest('details').open, false)
  f.settings()
  assert.equal(f.view.getByRole('checkbox').checked, true)
})

test('repoStatus=false hides both conversation entries and makes no requests', async t => {
  for (const slot of ['conversation.session.header.actions', 'conversation.hero.options']) {
    const f = await mount(t, { enabled: false, slot }); assert.equal(f.entry, undefined); assert.equal(f.calls.length, 0)
  }
})
