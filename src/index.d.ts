/** Host half of @vent0s/dsh-mod-workspace-files. */
export const name: 'dsh-mod-workspace-files'
export const inject: ['connection', 'webServer', 'settings', 'credentials', 'llm', 'workspaceRegistry']
export interface Config {
  /** Multi-repository status in the session header. Default: true. */
  repoStatus?: boolean
  /** Keep the legacy '#' absolute-path menu and search RPC. Default: true. */
  hashFileSearch?: boolean
  /** Keep the session-header folder action and native-open RPC. Default: true. */
  openWorkspaceFolder?: boolean
}
/** @param ctx - Cordis host context. @param config - Optional legacy feature switches. */
export function apply(ctx: any, config?: Config): void
