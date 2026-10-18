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
const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://localhost/' })
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
const React = requireWeb('react')
const { render, fireEvent, within, cleanup } = requireRoot('@testing-library/react')
const { act } = React

async function mount(configure, { loopback = true } = {}) {
  let client, dictionary, entry, Component
  const calls = []
  runInNewContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: ({ factory }) => { client = factory(name => name === 'react' ? React : {}) } } },
    AbortController, console, setTimeout, clearTimeout,
  })
  const providers = [
    { id: 'kimi', route: 'kimi-coding', label: 'Kimi', mode: 'coding', configured: false, models: [], candidates: [{ id: 'k3' }, { id: 'kimi-for-coding' }], defaultModel: 'k3', modes: [{ id: 'coding', baseURL: 'https://api.kimi.com/coding' }] },
    { id: 'glm', route: 'bigmodel', label: 'GLM', mode: 'coding', configured: false, models: [], candidates: [{ id: 'glm-5.3' }, { id: 'glm-4.7' }], defaultModel: 'glm-5.3', modes: [{ id: 'coding', baseURL: 'https://open.bigmodel.cn/api/anthropic' }, { id: 'api', baseURL: 'https://open.bigmodel.cn/api/paas/v4' }] },
  ]
  const services = {
    locale: { register: (_ns, dictionaries) => { dictionary = dictionaries.zh; return () => {} }, bind: () => key => dictionary[key] },
    slots: { inject: (_name, callback) => callback(), register: (options, component) => {
      assert.equal(options.name, 'settings.models.provider-card', 'must extend Models instead of adding a settings page')
      assert.equal(options.key, 'llm-pi-ai')
      assert.equal(options.label, undefined)
      entry = options; Component = component
    } },
    connection: { isLoopback: loopback, rpc: { call: async (channel, endpoint, payload, signal) => {
      assert.equal(channel, '/mod-providers')
      if (endpoint === 'describe') return { ok: true, value: { providers } }
      calls.push({ endpoint, payload, signal })
      return configure(payload)
    } } },
  }
  client.apply({ get: name => services[name], effect: callback => callback(), on: () => {} }, { hashFileSearch: false, openWorkspaceFolder: false, repoStatus: false })
  if (!loopback) return { entry, calls }
  let view
  // Match the native Models owner share: one occurrence inside each provider row.
  await act(async () => { view = render(React.createElement('ul', null,
    [...providers, { route: 'openai', label: 'OpenAI' }].map(provider => React.createElement('li', { key: provider.route, 'data-testid': provider.route },
      React.createElement('span', null, provider.label),
      React.createElement(Component, {
        ...entry.inject(), t: key => dictionary[key],
        provider: { provider: provider.route, displayName: provider.label, settingsNs: 'llm-pi-ai', settingsPath: ['providers', provider.route] },
        configured: true, keyConfigured: false,
      }))))) })
  return { view, calls }
}

test('native Models cards: enter key, check, clear key and render configured models with no separate page', async t => {
  t.after(cleanup)
  let complete
  const { view, calls } = await mount(() => new Promise(resolve => { complete = resolve }))
  assert.equal(view.container.querySelectorAll('form').length, 2)
  assert.equal(view.container.querySelectorAll('input[type=password]').length, 2)
  assert.equal(view.queryByRole('heading', { name: 'GLM / Kimi' }), null)
  assert.equal(within(view.getByTestId('openai')).queryByRole('form'), null)
  assert.ok(within(view.getByTestId('kimi-coding')).getByRole('form', { name: 'Kimi' }))
  assert.ok(within(view.getByTestId('bigmodel')).getByRole('form', { name: 'GLM' }))
  const card = within(view.getByRole('form', { name: 'Kimi' }))
  const key = card.getByLabelText('API Key')
  const button = card.getByRole('button', { name: '检查可用性并配置模型' })
  assert.equal(button.disabled, true)
  assert.equal(card.getByLabelText('验证模型').value, 'k3')
  fireEvent.change(card.getByLabelText('验证模型'), { target: { value: 'kimi-for-coding' } })
  fireEvent.change(key, { target: { value: 'KEY_NOT_VISIBLE' } })
  assert.equal(button.disabled, false)
  fireEvent.click(button)
  assert.equal(button.disabled, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].payload.provider, 'kimi')
  assert.equal(calls[0].payload.apiKey, 'KEY_NOT_VISIBLE')
  assert.equal(calls[0].payload.model, 'kimi-for-coding')
  await act(async () => complete({ ok: true, value: { models: ['kimi-for-coding'], verifiedModel: 'kimi-for-coding' } }))
  assert.equal(key.value, '')
  assert.match(card.getByRole('status').textContent, /检查通过并已保存/)
  assert.match(view.container.textContent, /kimi-for-coding/)
  assert.match(card.getByRole('status').textContent, /kimi-for-coding/)
  assert.doesNotMatch(view.container.textContent, /KEY_NOT_VISIBLE|Moonshot/)
})

test('429 preserves the typed key and disables repeated checks during Retry-After', async t => {
  t.after(cleanup)
  const { view, calls } = await mount(async () => ({ ok: false, error: { message: '模型服务繁忙（HTTP 429 / 1305）', details: { retryAfterSeconds: 60 } } }))
  const card = within(view.getByRole('form', { name: 'GLM' }))
  const key = card.getByLabelText('API Key')
  fireEvent.change(key, { target: { value: 'test-key' } })
  await act(async () => fireEvent.click(card.getByRole('button', { name: '检查可用性并配置模型' })))
  const button = card.getByRole('button', { name: '等待 60 秒后重试' })
  assert.equal(button.disabled, true)
  fireEvent.click(button)
  assert.equal(calls.length, 1)
  assert.equal(key.value, 'test-key')
  assert.equal(calls[0].payload.model, 'glm-5.3')
  assert.match(card.getByRole('alert').textContent, /1305/)
})

test('the provider check controls remain unavailable on remote connections', async () => {
  const result = await mount(() => { throw new Error('must not call') }, { loopback: false })
  assert.equal(result.entry, undefined)
  assert.equal(result.calls.length, 0)
})

test('GLM account selection updates the endpoint; failure is visible and permits correction', async t => {
  t.after(cleanup)
  const { view, calls } = await mount(async () => ({ ok: false, error: { message: 'API Key 验证失败（401），原配置未修改。' } }))
  const card = within(view.getByRole('form', { name: 'GLM' }))
  fireEvent.change(card.getByLabelText('账号类型'), { target: { value: 'api' } })
  assert.ok(card.getByText('https://open.bigmodel.cn/api/paas/v4'))
  const key = card.getByLabelText('API Key')
  fireEvent.change(key, { target: { value: 'invalid-key' } })
  await act(async () => fireEvent.click(card.getByRole('button', { name: '检查可用性并配置模型' })))
  assert.equal(calls[0].payload.mode, 'api')
  assert.match(card.getByRole('alert').textContent, /401/)
  assert.equal(key.value, 'invalid-key')
  assert.equal(card.getByRole('button', { name: '检查可用性并配置模型' }).disabled, false)
})
