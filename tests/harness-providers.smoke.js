import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'
import { PROVIDER_PRESETS, configureGlmModel } from '../lib/providers.js'

// Run against an installed source checkout without adding harness dependencies to the Mod.
const root = resolve(process.env.DSH_HARNESS_ROOT ?? '../deepseek-harness')
const requireHarness = createRequire(join(root, 'package.json'))
const { tsImport } = requireHarness('tsx/esm/api')
const load = path => tsImport(pathToFileURL(join(root, path)).href, { parentURL: import.meta.url, tsconfig: false })
const { resolveProfiles } = await load('packages/llm/llm-pi-ai/src/config.ts')
const { PiAiAdapter } = await load('packages/llm/llm-pi-ai/src/adapter.ts')
const { discoverModels } = await load('packages/llm/llm-pi-ai/src/discovery.ts')
const auth = {
  credentials: { read: async () => undefined, list: async () => [] },
  authContext: { env: async () => undefined, fileExists: async () => false },
}

for (const [name, preset] of Object.entries(PROVIDER_PRESETS)) {
 for (const [mode, endpoint] of Object.entries(preset.modes)) {
  const route = preset.route
  test(`${name}/${mode}: native catalog and real adapter dispatch with local SSE`, async t => {
    const discovered = await discoverModels({ provider: preset.catalogRoute ?? route })
    const profile = { displayName: preset.displayName, baseURL: endpoint.baseURL, ...(preset.catalogRoute ? { api: endpoint.api, models: discovered.map(model => configureGlmModel(model, endpoint.api)), ...(endpoint.compat ? { compat: endpoint.compat } : {}) } : {}) }
    const original = resolveProfiles({ [route]: profile })
    const catalog = new PiAiAdapter({ profiles: () => original, resolveApiKey: async () => 'test-key', auth })
    const models = await catalog.listModels(route)
    const model = name === 'glm' ? 'glm-5.3' : 'kimi-for-coding'
    assert.ok(models.some(entry => entry.id === model), `${route} catalog must contain ${model}`)
    const requests = []
    const anthropic = endpoint.api === 'anthropic-messages'
    const server = createServer(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      requests.push({ path: req.url, headers: req.headers, body: JSON.parse(body) })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (anthropic) {
        const events = [
          { type: 'message_start', message: { id: 'msg_test', type: 'message', role: 'assistant', model, content: [], usage: { input_tokens: 3, output_tokens: 0 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
          { type: 'message_stop' },
        ]
        for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      } else {
        for (const event of [
          { choices: [{ delta: { role: 'assistant', content: 'hello' }, index: 0, finish_reason: null }] },
          { choices: [{ delta: {}, index: 0, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } },
        ]) res.write(`data: ${JSON.stringify(event)}\n\n`)
        res.write('data: [DONE]\n\n')
      }
      res.end()
    })
    t.after(async () => { server.closeAllConnections(); await new Promise(done => server.close(done)) })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const prefix = new URL(profile.baseURL).pathname.replace(/\/$/, '')
    const baseURL = `http://127.0.0.1:${server.address().port}${prefix}`
    const profiles = resolveProfiles({ [route]: { ...profile, baseURL } })
    const adapter = new PiAiAdapter({ profiles: () => profiles, resolveApiKey: async () => 'test-key', auth })
    if (name === 'glm') {
      const info = await adapter.resolveModel(route, model)
      assert.deepEqual(info.reasoning.efforts.map(effort => effort.id), ['low', 'high', 'max'])
    }
    for (const reasoningEffort of name === 'glm' ? [undefined, 'low', 'high', 'max'] : [undefined]) {
    const chunks = []
    for await (const chunk of adapter.stream({
      provider: route, model, messages: [], maxTokens: 128, reasoningEffort,
      tools: [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
    })) chunks.push(chunk)
    assert.deepEqual(chunks.at(-1)?.reason, { kind: 'stop' })
    assert.equal(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), 'hello')
    const request = requests.at(-1)
    assert.equal(new URL(request.path, baseURL).pathname, `${prefix}${anthropic ? '/v1/messages' : '/chat/completions'}`)
    assert.equal(request.body.model, model)
    assert.equal(request.body.max_tokens, 128)
    assert.equal(request.body.tools[0][anthropic ? 'name' : 'type'], anthropic ? 'read_file' : 'function')
    assert.ok(Object.values(request.headers).some(value => String(value).includes('test-key')))
    if (name === 'glm') {
      assert.equal(anthropic ? request.body.output_config?.effort : request.body.reasoning_effort, reasoningEffort)
      assert.equal(request.body.thinking?.type, reasoningEffort === undefined ? undefined : anthropic ? 'adaptive' : 'enabled')
      assert.equal(request.body.thinking?.budget_tokens, undefined)
    }
    }
    assert.equal(requests.length, name === 'glm' ? 4 : 1)
  })
}
}

test('checked keys and models persist through real Harness settings and credential services', async t => {
  const { mkdtemp, readFile, rm, mkdir, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { createProviderManager } = await import('../lib/provider-manager.js')
  const requireLlm = createRequire(join(root, 'packages/llm/llm-pi-ai/package.json'))
  const { Context } = await import(pathToFileURL(requireLlm.resolve('@deepseek-ai/cordis')).href)
  const { default: CredentialsLocal } = await load('packages/credentials/credentials-local/src/index.ts')
  const LlmPiAi = await load('packages/llm/llm-pi-ai/src/index.ts')
  const { default: LlmRuntime } = await import(pathToFileURL(requireLlm.resolve('@deepseek-ai/dsh-llm')).href)
  const home = await mkdtemp(join(tmpdir(), 'dsh-mod-native-store-'))
  let ctx
  let settingsPath
  if (existsSync(join(root, 'packages/settings/settings-file/src/index.ts'))) {
    const { default: SettingsFile } = await load('packages/settings/settings-file/src/index.ts')
    ctx = new Context()
    settingsPath = join(home, 'settings.yaml')
    await ctx.plugin(SettingsFile, { path: settingsPath, watch: false })
    await ctx.plugin(CredentialsLocal, { dshHome: home })
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, { providers: {} })
  } else {
    const requireCli = createRequire(join(root, 'packages/settings/settings/package.json'))
    const imported = name => import(pathToFileURL(requireCli.resolve(name)).href)
    const { boot, initProfile, readProfilePatches } = await imported('@deepseek-ai/dsh-app-boot')
    const { default: ConfigEditor } = await imported('@deepseek-ai/dsh-config-editor')
    const { default: Settings } = await imported('@deepseek-ai/dsh-settings')
    const { default: Timer } = await imported('@deepseek-ai/cordis-plugin-timer')
    const { default: Hmr } = await imported('@deepseek-ai/dsh-hmr')
    const dir = join(home, 'profiles', 'test')
    initProfile(dir, ['test-bundle'])
    const bundle = join(dir, 'node_modules', 'test-bundle')
    await mkdir(bundle, { recursive: true })
    await writeFile(join(home, 'package.json'), '{"name":"mod-test"}\n')
    await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: 'test-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
    await writeFile(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
      { id: 'config-editor', name: 'cordis:editor' },
      { id: 'settings', name: 'cordis:settings' },
      { id: 'credentials', name: 'cordis:credentials', config: { dshHome: home } },
      { id: 'llm', name: 'cordis:llm' },
      { id: 'llm-pi-ai', name: 'cordis:pi', config: { providers: {} } },
    ] }]))
    await writeFile(join(dir, 'cordis.yml'), '[]\n')
    settingsPath = join(dir, 'cordis.patch.yml')
    const profile = { name: 'test', startedBundles: ['test-bundle'], dir, patchPath: settingsPath,
      installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined }
    ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), ctx => {
      ctx.provide('profileContext', profile)
      ctx.provide('appReady', { onReady: listener => { listener(); return () => {} } })
      Object.assign(ctx.loader.builtins, { editor: ConfigEditor, settings: Settings, credentials: CredentialsLocal, llm: LlmRuntime, pi: LlmPiAi })
    })
    await ctx.plugin(Timer)
    await ctx.plugin(Hmr, { root: [], ignored: [], debounce: 0 })
    await ctx.hmr.runExclusive(async () => {})
  }
  t.after(async () => { await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) })
  const handle = createProviderManager(ctx, { fetchImpl: async (url) => url.endsWith('/messages') ? Response.json({ type: 'message', content: [{ type: 'text', text: 'OK' }] }) : Response.json({ choices: [{ message: { role: 'assistant', content: 'OK' } }] }) })
  for (const [provider, preset] of Object.entries(PROVIDER_PRESETS)) for (const mode of Object.keys(preset.modes)) {
  const result = await handle('configure', { provider, mode, model: provider === 'kimi' ? 'kimi-for-coding' : 'glm-5.3', apiKey: 'native-test-key' })
  assert.equal(result.ok, true, JSON.stringify(result))
  const configured = ctx.settings.describe().find(entry => entry.ns === 'llm-pi-ai').value.providers[preset.route]
  assert.equal((await ctx.credentials.resolve(configured.apiKeyEnv)).value, 'native-test-key')
  assert.ok(configured.models.some(model => model.id === (provider === 'kimi' ? 'kimi-for-coding' : 'glm-5.3')))
  if (provider === 'glm') {
    assert.equal(configured.api, preset.modes[mode].api)
    assert.equal(configured.models.find(model => model.id === 'glm-5.3').contextWindow, 1000000)
    const info = await ctx.llm.resolveModelInfo(preset.route, 'glm-5.3')
    assert.deepEqual(info.reasoning.efforts.map(effort => effort.id), ['low', 'high', 'max'])
  }
  assert.doesNotMatch(await readFile(settingsPath, 'utf8'), /native-test-key/)
  assert.match(await readFile(join(home, '.credentials.yaml'), 'utf8'), /native-test-key/)
  }
})
