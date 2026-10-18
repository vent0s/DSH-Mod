import type { Config } from './index.js'
/** Browser half: Models key checks, optional '#' overlay, repository status and folder action. */
export const inject: ['connection', 'slots', 'locale']
/** @param ctx - Cordis client context. @param config - Optional legacy feature switches. */
export function apply(ctx: any, config?: Config): void
