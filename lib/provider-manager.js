import { randomUUID } from 'node:crypto'
import { PROVIDER_PRESETS, configureGlmModel, glmProbeThinking } from './providers.js'

const NS = 'llm-pi-ai'
const ok = value => ({ ok: true, value })
const failure = (code, message, details = {}) => ({ ok: false, error: { code, message, details } })

// BigModel documents business codes separately from HTTP status:
// https://docs.bigmodel.cn/cn/api/api-code.md
const GLM_LIMITS = {
  1113: ['insufficient-balance', '账户余额不足，请检查余额及所选账号类型'],
  1302: ['rate-limited', '账户请求速率达到限制，请减少同时使用该账号的请求'],
  1305: ['provider-overloaded', '该模型服务繁忙，请稍后重试'],
  1308: ['quota-exhausted', '当前时段的使用额度已用完，请到智谱控制台查看重置时间'],
  1309: ['subscription-expired', 'GLM Coding Plan 已到期，请检查套餐状态'],
  1310: ['quota-exhausted', '本周或本月的使用额度已用完，请到智谱控制台查看重置时间'],
  1311: ['model-not-allowed', '当前套餐不支持所选模型，请选择套餐支持的模型'],
  1313: ['account-restricted', '账号触发了公平使用限制，请到智谱编程套餐页面查看处理方式'],
  1314: ['subscription-expired', '企业套餐已失效，请联系企业管理员'],
  1315: ['wrong-key-type', '该 Key 仅适用于企业编程套餐，请检查 Key 与账号类型是否匹配'],
}
for (const code of ['1316', '1317', '1318', '1319', '1320', '1321']) {
  GLM_LIMITS[code] = ['quota-exhausted', '套餐使用额度已用完，且无法使用超额付费；请在智谱控制台查看重置时间及付费限制']
}

function retryAfterSeconds(value, now) {
  if (!value) return undefined
  const seconds = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : (Date.parse(value) - now) / 1000
  return Number.isFinite(seconds) && seconds >= 0 ? Math.max(1, Math.ceil(seconds)) : undefined
}

/** Read a bounded JSON response without retaining or exposing provider error bodies. */
async function responseJson(response) {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('empty-response')
  const chunks = []
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > 1024 * 1024) throw new Error('response-too-large')
      chunks.push(value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally {
    await reader.cancel().catch(() => {}) // The response may already have closed or aborted.
  }
}

/** A short generation verifies account/model access; catalog membership alone is insufficient. */
export async function probeModel({ api, baseURL, model, apiKey, signal, fetchImpl = fetch, now = Date.now }) {
  const anthropic = api === 'anthropic-messages'
  const headers = { 'content-type': 'application/json', 'user-agent': 'DSH-Mod/0.4.0' }
  if (anthropic) {
    headers['x-api-key'] = apiKey
    headers['anthropic-version'] = '2023-06-01'
  } else headers.authorization = `Bearer ${apiKey}`
  const requestSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30_000)])
  try {
    const response = await fetchImpl(`${baseURL}${anthropic ? '/v1/messages' : '/chat/completions'}`, {
      method: 'POST', headers, signal: requestSignal, redirect: 'error',
      body: JSON.stringify({
        model, messages: [{ role: 'user', content: 'Reply with OK.' }],
        max_tokens: 16, stream: false, ...glmProbeThinking(model, api),
      }),
    })
    if (!response.ok) {
      let providerCode
      // Read only a bounded error body and retain only a numeric business code.
      // Arbitrary provider messages may contain echoed secrets and never leave this function.
      try {
        const data = await responseJson(response)
        const code = String(data?.error?.code ?? data?.code ?? '')
        if (/^\d{3,6}$/.test(code)) providerCode = code
      } catch { /* A non-JSON error still retains its HTTP status. */ }
      signal?.throwIfAborted()
      return {
        id: model, available: false, status: response.status,
        reason: `HTTP ${response.status}${providerCode ? ` / ${providerCode}` : ''}`,
        ...(providerCode ? { providerCode } : {}),
        retryAfterSeconds: retryAfterSeconds(response.headers.get('retry-after'), now()),
      }
    }
    const data = await responseJson(response)
    const valid = anthropic
      ? data?.type === 'message' && Array.isArray(data.content)
      : Array.isArray(data?.choices) && data.choices.some(choice => choice?.message?.role === 'assistant')
    return { id: model, available: valid, ...valid ? {} : { reason: '响应格式无效' } }
  } catch {
    if (signal?.aborted) throw new Error('cancelled')
    return { id: model, available: false, reason: requestSignal.aborted ? '请求超时' : '网络或响应错误' }
  }
}

/** Host-only setup: validate first, stage a new credential, then publish one settings mutation. */
export function createProviderManager(ctx, { fetchImpl = fetch, now = Date.now } = {}) {
  let checking = false
  const cooldowns = new Map()
  async function choices(preset, profile, signal) {
    const catalog = await ctx.llm.discoverModels(NS, { provider: preset.catalogRoute ?? preset.route }, signal)
    const ids = [...new Set([...(profile?.models ?? []), ...catalog].map(model => model.id))]
    return { catalog, ids, defaultModel: profile?.models?.[0]?.id ?? (ids.includes(preset.preferredModel) ? preset.preferredModel : ids[0]) }
  }
  async function describe(signal) {
    const profiles = ctx.settings.describe().find(entry => entry.ns === NS)?.value?.providers ?? {}
    const providers = []
    for (const [id, preset] of Object.entries(PROVIDER_PRESETS)) {
      const profile = profiles[preset.route]
      const { catalog, ids, defaultModel } = await choices(preset, profile, signal)
      const info = profile?.apiKeyEnv ? await ctx.credentials.describe(profile.apiKeyEnv) : undefined
      providers.push({
        id, route: preset.route, label: preset.displayName,
        modes: Object.entries(preset.modes).map(([id, mode]) => ({ id, ...mode })),
        mode: Object.keys(preset.modes).find(mode => preset.modes[mode].baseURL === profile?.baseURL) ?? preset.defaultMode,
        configured: info?.configured === true,
        defaultModel,
        candidates: ids.map(id => ({ id, name: catalog.find(model => model.id === id)?.name ?? id })),
        models: (profile?.models ?? []).map(model => ({ id: model.id, name: model.name ?? model.id })),
      })
    }
    return { providers }
  }
  return async (endpoint, payload, signal) => {
    if (endpoint === 'describe') {
      try { return ok(await describe(signal)) }
      catch { return failure('unavailable', '无法读取模型设置，请确认本体的模型与凭据服务已加载。') }
    }
    if (endpoint !== 'configure') return failure('bad-request', '未知操作')
    if (!payload || !Object.hasOwn(PROVIDER_PRESETS, payload.provider)) return failure('bad-request', '请选择 Kimi 或 GLM')
    const preset = PROVIDER_PRESETS[payload.provider]
    if (!Object.hasOwn(preset.modes, payload.mode)) return failure('bad-request', '请选择账号类型')
    const apiKey = typeof payload.apiKey === 'string' ? payload.apiKey.trim() : ''
    if (!apiKey || apiKey.length > 8192 || /[^\x21-\x7e]/.test(apiKey)) return failure('bad-key', '请输入有效的 API Key（不能包含空格或换行）')
    if (checking) return failure('busy', '另一次模型检查正在进行，请稍后重试。')
    const remaining = Math.ceil(((cooldowns.get(payload.provider) ?? 0) - now()) / 1000)
    if (remaining > 0) return failure('cooldown', `请等待 ${remaining} 秒后再检查；此次没有发送请求，原配置未修改。`, { retryAfterSeconds: remaining })
    checking = true
    let stagedRef
    let published = false
    try {
      const descriptor = ctx.settings.describe({ redactSecrets: true }).find(entry => entry.ns === NS)
      if (!descriptor) return failure('unavailable', '本体未加载多模型设置服务。')
      const previous = descriptor.value?.providers?.[preset.route] ?? {}
      const { baseURL, api, compat } = preset.modes[payload.mode]
      const { catalog, ids, defaultModel } = await choices(preset, previous, signal)
      if (ids.length === 0) return failure('catalog-unavailable', '本体模型目录不可用，请先更新本体。')
      const model = payload.model ?? defaultModel
      if (typeof model !== 'string' || !ids.includes(model)) return failure('bad-model', '请选择模型目录中或已配置的模型')
      signal?.throwIfAborted()
      // One click, one generation. Never scan the provider catalog or automatically retry.
      const result = await probeModel({ api, baseURL, model, apiKey, signal, fetchImpl, now })
      if (result.status === 401) return failure('invalid-key', 'API Key 验证失败（401），原配置未修改。')
      if (result.status === 429) {
        const known = payload.provider === 'glm' ? GLM_LIMITS[result.providerCode] : undefined
        const [code, explanation] = known ?? ['rate-limited', '服务商返回限制错误，未提供可识别的原因；可能涉及请求速率、并发或账号额度']
        const wait = result.retryAfterSeconds ?? (['rate-limited', 'provider-overloaded'].includes(code) ? 60 : 0)
        if (wait) cooldowns.set(payload.provider, now() + wait * 1000)
        return failure(code, `${explanation}（${result.reason}）。本次仅发送 1 次验证请求；${wait ? `请至少等待 ${wait} 秒后重试；` : ''}原配置未修改。`, {
          model, status: 429, ...(result.providerCode ? { providerCode: result.providerCode } : {}),
          ...(wait ? { retryAfterSeconds: wait } : {}),
        })
      }
      if (result.status >= 500 || (!result.available && result.status === undefined)) {
        return failure('provider-unavailable', '模型接口超时、网络异常或响应无效，请稍后重试；原配置未修改。')
      }
      if (!result.available) return failure('model-unavailable', `所选模型未通过调用检查（${result.reason}），请检查 Key、账号类型和模型权限；原配置未修改。`)
      signal?.throwIfAborted()
      // A fresh reference prevents overwriting a working key before the settings commit, including env-shadowed references.
      stagedRef = `DSH_MOD_${payload.provider.toUpperCase()}_${randomUUID().replaceAll('-', '_')}`
      await ctx.credentials.set(stagedRef, apiKey)
      signal?.throwIfAborted()
      const models = [...(previous.models ?? [])]
      if (!models.some(entry => entry.id === model)) models.push({ id: model })
      const next = {
          ...previous,
          displayName: preset.displayName, baseURL, apiKeyEnv: stagedRef,
          // A custom route needs a protocol and the capacities that builtin routes inherit.
          ...(preset.catalogRoute ? { api, ...(compat ? { compat } : {}) } : {}),
          models: models.map(existing => {
            const model = { ...(preset.catalogRoute ? catalog.find(entry => entry.id === existing.id) : {}), ...existing }
            // Wire compatibility switches belong to their protocol, not the account key.
            if (previous.api && previous.api !== api) delete model.compat
            return payload.provider === 'glm' ? configureGlmModel(model, api) : model
          }),
      }
      delete next.modelOverrides
      if (previous.api && previous.api !== api && !compat) delete next.compat
      await ctx.settings.mutate(NS, [{ op: 'set', path: ['providers', preset.route], value: next }], descriptor.revision)
      published = true
      return ok({
        provider: payload.provider, models: next.models.map(({ id }) => id), verifiedModel: model,
      })
    } catch (error) {
      if (signal?.aborted) return failure('cancelled', '检查已取消，原配置未修改。')
      if (error?.code === 'SETTINGS_CONFLICT') return failure('conflict', '检查期间设置已变更，请重试；原配置未覆盖。')
      return failure('configure-failed', '检查或保存失败，原配置未修改。请确认本体支持该模型目录且配置目录可写。')
    } finally {
      if (stagedRef && !published) {
        try { await ctx.credentials.unset(stagedRef) }
        catch { ctx.logger?.warn('dsh-mod: could not remove an unused staged credential') }
      }
      checking = false
    }
  }
}
