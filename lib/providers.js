/** Only the two domestic services exposed by the Mod settings page. */
export const PROVIDER_PRESETS = Object.freeze({
  kimi: {
    route: 'kimi-coding',
    displayName: 'Kimi',
    preferredModel: 'k3',
    defaultMode: 'coding',
    modes: { coding: { label: 'Kimi Code', baseURL: 'https://api.kimi.com/coding', api: 'anthropic-messages' } },
  },
  glm: {
    route: 'bigmodel',
    catalogRoute: 'zai-coding-cn',
    displayName: 'GLM',
    preferredModel: 'glm-5.3',
    defaultMode: 'coding',
    modes: {
      coding: { label: 'Coding Plan', baseURL: 'https://open.bigmodel.cn/api/anthropic', api: 'anthropic-messages' },
      api: { label: '开放平台 API', baseURL: 'https://open.bigmodel.cn/api/paas/v4', api: 'openai-completions', compat: { maxTokensField: 'max_tokens', thinkingFormat: 'zai' } },
    },
  },
})

// Discovery only supplies names and token limits for custom routes. These are
// the actual effort levels, not aliases that the provider silently remaps.
// https://docs.bigmodel.cn/cn/guide/capabilities/thinking.md
const GLM_EFFORTS = {
  'glm-5.3': { low: 'low', high: 'high', max: 'max' },
  'glm-5.3-highspeed': { low: 'low', high: 'high', max: 'max' },
  'glm-5.3-flash': { low: 'low', high: 'high', max: 'max' },
  'glm-5.3-flashx': { low: 'low', high: 'high', max: 'max' },
  'glm-5.2': { off: null, high: 'high', max: 'max' },
  'glm-5.2-highspeed': { off: null, high: 'high', max: 'max' },
}

/** Add missing GLM effort metadata without overwriting manual model settings. */
export function configureGlmModel(model, api) {
  if (!Object.hasOwn(GLM_EFFORTS, model.id)) return model
  const efforts = GLM_EFFORTS[model.id]
  return {
    ...model,
    reasoningEfforts: model.reasoningEfforts ?? { ...efforts },
    compat: {
      ...(api === 'anthropic-messages'
        ? { forceAdaptiveThinking: true }
        : {
          supportsReasoningEffort: true,
          // This shared thinking.type + reasoning_effort encoding honors an
          // absent off level. pi-ai's "zai" format instead sends disabled for
          // an unspecified effort, which GLM-5.3 rejects. Omission keeps the
          // provider's default (max), without changing other models' defaults.
          thinkingFormat: 'deepseek', maxTokensField: 'max_tokens',
        }),
      ...model.compat,
    },
  }
}

/** Mandatory-thinking models must be probed at low effort instead of disabled. */
export function glmProbeThinking(model, api) {
  const efforts = Object.hasOwn(GLM_EFFORTS, model) ? GLM_EFFORTS[model] : undefined
  if (!efforts || Object.hasOwn(efforts, 'off')) return { thinking: { type: 'disabled' } }
  return api === 'anthropic-messages'
    ? { thinking: { type: 'adaptive' }, output_config: { effort: 'low' } }
    : { thinking: { type: 'enabled' }, reasoning_effort: 'low' }
}
