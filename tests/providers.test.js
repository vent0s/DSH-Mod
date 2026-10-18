import test from 'node:test'
import assert from 'node:assert/strict'
import { createProviderManager, probeModel } from '../lib/provider-manager.js'
import { PROVIDER_PRESETS, configureGlmModel } from '../lib/providers.js'

function fixture(fetchImpl, options = {}) {
  const credentials = new Map([['OLD_KEY', 'old-secret']])
  const state = { providers: { 'kimi-coding': { apiKeyEnv: 'OLD_KEY', models: [{ id: 'good', contextWindow: 1048576 }] }, zai: {}, 'moonshotai-cn': {}, other: { custom: true } } }
  const writes = []
  let rejectSave = false
  const ctx = {
    settings: {
      describe: () => [{ ns: 'llm-pi-ai', revision: 7, value: state }],
      mutate: async (ns, ops, revision) => {
        assert.equal(ns, 'llm-pi-ai'); assert.equal(revision, 7)
        if (rejectSave) throw Object.assign(new Error('conflict'), { code: 'SETTINGS_CONFLICT' })
        for (const op of ops) {
          if (op.op === 'unset') delete state.providers[op.path[1]]
          else state.providers[op.path[1]] = op.value
        }
        writes.push(ops)
      },
    },
    credentials: {
      describe: async ref => ({ configured: credentials.has(ref) }),
      set: async (ref, value) => credentials.set(ref, value),
      unset: async ref => credentials.delete(ref),
    },
    llm: { discoverModels: async () => [{ id: 'good' }, { id: 'blocked' }] },
  }
  return { handle: createProviderManager(ctx, { fetchImpl, ...options }), state, credentials, writes, ctx, rejectSave: () => { rejectSave = true } }
}
const request = { provider: 'kimi', mode: 'coding', apiKey: 'new-secret' }
const completion = () => Response.json({ type: 'message', content: [{ type: 'text', text: 'OK' }] })

test('two cards expose only kimi.com and bigmodel.cn, never saved secrets', async () => {
  const f = fixture(() => { throw new Error('must not fetch') })
  const result = await f.handle('describe')
  assert.deepEqual(result.value.providers.map(p => p.id), ['kimi', 'glm'])
  assert.equal(result.value.providers[0].configured, true)
  assert.doesNotMatch(JSON.stringify(result), /old-secret|OLD_KEY|moonshot|api.z.ai/)
  for (const p of result.value.providers) for (const mode of p.modes) assert.match(new URL(mode.baseURL).hostname, /^(api\.kimi\.com|open\.bigmodel\.cn)$/)
})

test('one click sends exactly one check to the fixed endpoint, even with a larger catalog', async () => {
  const calls = []
  const f = fixture(async (url, options) => {
    assert.equal(f.writes.length, 0); assert.equal(f.credentials.size, 1)
    calls.push({ url, options })
    return JSON.parse(options.body).model === 'good' ? completion() : new Response('denied new-secret', { status: 403 })
  })
  const result = await f.handle('configure', { ...request, baseURL: 'https://evil.invalid' })
  assert.equal(result.ok, true)
  assert.deepEqual(result.value.models, ['good'])
  assert.equal(result.value.verifiedModel, 'good')
  assert.equal(calls.length, 1)
  assert.equal(JSON.parse(calls[0].options.body).model, 'good')
  for (const call of calls) {
    assert.equal(call.url, 'https://api.kimi.com/coding/v1/messages')
    assert.equal(call.options.headers['x-api-key'], 'new-secret')
    assert.equal(call.options.redirect, 'error')
  }
  const saved = f.state.providers['kimi-coding']
  assert.notEqual(saved.apiKeyEnv, 'OLD_KEY')
  assert.equal(f.credentials.get(saved.apiKeyEnv), 'new-secret')
  assert.equal(f.credentials.get('OLD_KEY'), 'old-secret')
  assert.deepEqual(saved.models, [{ id: 'good', contextWindow: 1048576 }])
  assert.deepEqual(f.state.providers.zai, {})
  assert.deepEqual(f.state.providers['moonshotai-cn'], {})
  assert.deepEqual(f.state.providers.other, { custom: true })
  assert.doesNotMatch(JSON.stringify(result), /new-secret|old-secret/)
})

for (const status of [401, 429, 403]) {
  test(`HTTP ${status} does not save credentials or configuration`, async () => {
    const f = fixture(async () => new Response('secret should never reach the UI', { status }))
    const result = await f.handle('configure', request)
    assert.equal(result.ok, false)
    assert.equal(f.writes.length, 0)
    assert.equal(f.credentials.size, 1)
    assert.doesNotMatch(JSON.stringify(result), /secret should/)
  })
}

test('a successful HTTP response must contain a generation, not an error or model listing', async () => {
  const f = fixture(async () => Response.json({ data: [{ id: 'good' }] }))
  assert.equal((await f.handle('configure', request)).ok, false)
  assert.equal(f.writes.length, 0)
})

test('a stale settings revision removes the staged key and leaves the previous configuration usable', async () => {
  const f = fixture(async () => completion()); f.rejectSave()
  const result = await f.handle('configure', request)
  assert.equal(result.error.code, 'conflict')
  assert.deepEqual([...f.credentials], [['OLD_KEY', 'old-secret']])
  assert.equal(f.state.providers['kimi-coding'].apiKeyEnv, 'OLD_KEY')
})

test('cancellation and concurrent checks cannot publish a partially checked route', async () => {
  let release
  const entered = new Promise(resolve => { release = resolve })
  const abort = new AbortController()
  const f = fixture(async (_url, options) => {
    release()
    await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
  })
  const pending = f.handle('configure', request, abort.signal)
  await entered
  assert.equal((await f.handle('configure', request)).error.code, 'busy')
  abort.abort()
  assert.equal((await pending).error.code, 'cancelled')
  assert.equal(f.writes.length, 0)
  assert.equal(f.credentials.size, 1)
})

test('malformed requests fail before any network access', async () => {
  const f = fixture(() => { throw new Error('must not fetch') })
  for (const input of [null, {}, { ...request, provider: 'moonshot' }, { ...request, mode: 'international' }, { ...request, model: 'not-in-catalog' }, { ...request, apiKey: 'bad\nkey' }, { ...request, apiKey: '' }]) {
    assert.equal((await f.handle('configure', input)).ok, false)
  }
})

for (const mode of ['coding', 'api']) {
  test(`GLM ${mode} uses bigmodel.cn with its matching protocol and a bounded non-thinking check`, async () => {
    const preset = PROVIDER_PRESETS.glm
    const anthropic = mode === 'coding'
    const result = await probeModel({ ...preset.modes[mode], model: 'glm-test', apiKey: 'test-key', fetchImpl: async (url, options) => {
      assert.equal(url, `${preset.modes[mode].baseURL}${anthropic ? '/v1/messages' : '/chat/completions'}`)
      assert.equal(options.headers[anthropic ? 'x-api-key' : 'authorization'], anthropic ? 'test-key' : 'Bearer test-key')
      const body = JSON.parse(options.body)
      assert.equal(body.max_tokens, 16)
      assert.deepEqual(body.thinking, { type: 'disabled' })
      return anthropic ? completion() : Response.json({ choices: [{ message: { role: 'assistant', content: 'OK' } }] })
    } })
    assert.equal(result.available, true)
  })

  test(`GLM-5.3 ${mode} persists working effort controls after one low-effort check`, async () => {
    const endpoint = PROVIDER_PRESETS.glm.modes[mode]
    let calls = 0
    const f = fixture(async (_url, options) => {
      calls++
      const body = JSON.parse(options.body)
      assert.equal(body.max_tokens, 16)
      assert.deepEqual(body.thinking, { type: mode === 'coding' ? 'adaptive' : 'enabled' })
      assert.equal(mode === 'coding' ? body.output_config.effort : body.reasoning_effort, 'low')
      return mode === 'coding' ? completion() : Response.json({ choices: [{ message: { role: 'assistant', content: 'OK' } }] })
    })
    // Also covers repairing an existing entry produced by the old configurator.
    f.state.providers.bigmodel = { apiKeyEnv: 'OLD_KEY', api: endpoint.api, models: [{ id: 'glm-5.3', contextWindow: 1000000, compat: {} }] }
    const result = await f.handle('configure', { ...request, provider: 'glm', mode, model: 'glm-5.3' })
    assert.equal(result.ok, true)
    assert.equal(calls, 1)
    const model = f.state.providers.bigmodel.models[0]
    assert.deepEqual(model.reasoningEfforts, { low: 'low', high: 'high', max: 'max' })
    assert.equal(model.contextWindow, 1000000)
    assert.equal(model.compat[mode === 'coding' ? 'forceAdaptiveThinking' : 'supportsReasoningEffort'], true)
  })
}

test('GLM account-type changes replace protocol switches while retaining manual effort choices', async () => {
  const f = fixture(async url => url.endsWith('/messages') ? completion() : Response.json({ choices: [{ message: { role: 'assistant' } }] }))
  f.state.providers.bigmodel = { apiKeyEnv: 'OLD_KEY', api: 'anthropic-messages', models: [
    { id: 'glm-5.3', reasoningEfforts: { high: 'high' }, compat: { forceAdaptiveThinking: true } },
  ] }
  for (const mode of ['api', 'coding']) {
    assert.equal((await f.handle('configure', { ...request, provider: 'glm', mode, model: 'glm-5.3' })).ok, true)
    const model = f.state.providers.bigmodel.models[0]
    assert.deepEqual(model.reasoningEfforts, { high: 'high' })
    assert.equal(model.compat.forceAdaptiveThinking, mode === 'coding' ? true : undefined)
    assert.equal(model.compat.thinkingFormat, mode === 'api' ? 'deepseek' : undefined)
  }
  const manual = { id: 'glm-5.3', reasoningEfforts: false, compat: { forceAdaptiveThinking: false } }
  assert.deepEqual(configureGlmModel(manual, 'anthropic-messages'), manual)
  const unknown = { id: 'future-custom-model', contextWindow: 10000 }
  assert.deepEqual(configureGlmModel(unknown, 'anthropic-messages'), unknown)
})

test('GLM checks only the selected model, retaining existing models and capacities', async () => {
  const seen = []
  const f = fixture(async (_url, options) => { seen.push(JSON.parse(options.body).model); return completion() })
  f.state.providers.bigmodel = { apiKeyEnv: 'OLD_KEY', api: 'anthropic-messages', baseURL: PROVIDER_PRESETS.glm.modes.coding.baseURL, models: [{ id: 'custom-glm', contextWindow: 1000000 }] }
  f.ctx.llm.discoverModels = async (_ns, request) => {
    if (request.provider === 'kimi-coding') return [{ id: 'good' }]
    assert.equal(request.provider, 'zai-coding-cn')
    return [{ id: 'glm-test', name: 'GLM Test', contextWindow: 200000, maxTokens: 32000 }]
  }
  const before = await f.handle('describe')
  assert.equal(before.value.providers[1].configured, true)
  assert.deepEqual(before.value.providers[1].models.map(m => m.id), ['custom-glm'])
  assert.equal(before.value.providers[1].defaultModel, 'custom-glm')
  assert.deepEqual(before.value.providers[1].candidates.map(m => m.id), ['custom-glm', 'glm-test'])
  const result = await f.handle('configure', { provider: 'glm', mode: 'coding', model: 'glm-test', apiKey: 'new-secret' })
  assert.equal(result.ok, true)
  assert.deepEqual(seen, ['glm-test'])
  assert.equal(result.value.verifiedModel, 'glm-test')
  assert.equal(f.state.providers.bigmodel.api, 'anthropic-messages')
  assert.deepEqual(f.state.providers.bigmodel.models, [{ id: 'custom-glm', contextWindow: 1000000 }, { id: 'glm-test', name: 'GLM Test', contextWindow: 200000, maxTokens: 32000 }])
  assert.equal(f.state.providers['zai-coding-cn'], undefined)
})

for (const [providerCode, code] of [
  ['1113', 'insufficient-balance'], ['1302', 'rate-limited'], ['1305', 'provider-overloaded'],
  ['1308', 'quota-exhausted'], ['1309', 'subscription-expired'], ['1310', 'quota-exhausted'],
  ['1311', 'model-not-allowed'], ['1313', 'account-restricted'], ['1315', 'wrong-key-type'],
]) {
  test(`GLM 429/${providerCode} distinguishes ${code} without exposing raw errors`, async () => {
    let calls = 0
    const f = fixture(async () => {
      calls++
      return Response.json({ error: { code: providerCode, message: 'echo new-secret; do not expose this body' } }, { status: 429 })
    })
    const result = await f.handle('configure', { ...request, provider: 'glm' })
    assert.equal(result.error.code, code)
    assert.equal(result.error.details.providerCode, providerCode)
    assert.match(result.error.message, /仅发送 1 次/)
    assert.doesNotMatch(JSON.stringify(result), /new-secret|echo/)
    assert.equal(calls, 1)
    assert.equal(f.writes.length, 0)
    assert.equal(f.credentials.size, 1)
  })
}

test('429 honors Retry-After across repeated clicks, with no automatic retry or partial save', async () => {
  let now = 100000, calls = 0
  const f = fixture(async () => {
    calls++
    return calls === 1 ? Response.json({ error: { code: '1302' } }, { status: 429, headers: { 'retry-after': '120' } }) : completion()
  }, { now: () => now })
  const input = { ...request, provider: 'glm' }
  assert.equal((await f.handle('configure', input)).error.details.retryAfterSeconds, 120)
  now += 30000
  const blocked = await f.handle('configure', input)
  assert.equal(blocked.error.code, 'cooldown')
  assert.equal(blocked.error.details.retryAfterSeconds, 90)
  assert.equal(calls, 1)
  assert.equal(f.writes.length, 0)
  now += 90000
  assert.equal((await f.handle('configure', input)).ok, true)
  assert.equal(calls, 2)
})

test('unknown/HTML 429 stays an unknown restriction and receives a local cooldown', async () => {
  let calls = 0
  const f = fixture(async () => { calls++; return new Response('secret HTML', { status: 429 }) })
  const first = await f.handle('configure', request)
  assert.equal(first.error.details.retryAfterSeconds, 60)
  assert.match(first.error.message, /未提供可识别的原因/)
  assert.doesNotMatch(JSON.stringify(first), /secret HTML/)
  assert.equal((await f.handle('configure', request)).error.code, 'cooldown')
  assert.equal(calls, 1)
})

test('Retry-After HTTP dates are parsed, and invalid dates fall back safely', async () => {
  const now = Date.parse('2026-09-22T01:00:00Z')
  for (const [header, expected] of [['Tue, 22 Sep 2026 01:02:00 GMT', 120], ['nonsense', undefined]]) {
    const result = await probeModel({ ...PROVIDER_PRESETS.glm.modes.coding, model: 'glm-5.3', apiKey: 'test-key', now: () => now,
      fetchImpl: async () => new Response('', { status: 429, headers: { 'retry-after': header } }) })
    assert.equal(result.status, 429)
    assert.equal(result.retryAfterSeconds, expected)
  }
})
