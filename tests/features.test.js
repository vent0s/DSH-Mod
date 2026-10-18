import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { apply } from '../lib/index.js'

for (const hashFileSearch of [true, false]) {
  for (const openWorkspaceFolder of [true, false]) {
    test(`host and browser feature switches: hash=${hashFileSearch}, folder=${openWorkspaceFolder}`, async () => {
      const config = { hashFileSearch, openWorkspaceFolder }
      const channels = []
      const disposed = []
      const cleanup = []
      const oldPort = process.env.DSH_MOD_GATEWAY_PORT
      delete process.env.DSH_MOD_GATEWAY_PORT
      try {
        apply({
          connection: { rpc: { handle: (channel) => {
            channels.push(channel)
            return () => disposed.push(channel)
          } } },
          effect: factory => cleanup.push(factory()),
        }, config)
      } finally {
        if (oldPort !== undefined) process.env.DSH_MOD_GATEWAY_PORT = oldPort
      }
      assert.equal(channels.includes('/mod-workspace-files'), hashFileSearch)
      assert.equal(channels.includes('/mod-workspace-open'), openWorkspaceFolder)
      for (const stop of cleanup) await stop()
      assert.deepEqual(disposed, channels)

      let client
      runInNewContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), {
        window: { __ModuleLoader__: { load: ({ factory }) => { client = factory(() => ({})) } } },
        console,
      })
      const slots = []
      const calls = []
      const services = {
        connection: { isLoopback: true, rpc: { call: async (channel) => { calls.push(channel); return { ok: true, value: { canOpen: false } } } } },
        locale: { register: () => () => {} },
        slots: { inject: (_name, factory) => factory(), register: entry => slots.push(entry.id ?? `${entry.name}:${entry.key}`) },
      }
      client.apply({ get: name => services[name], effect: factory => factory(), on: () => {} }, config)
      assert.equal(slots.includes('settings.models.provider-card:llm-pi-ai'), true)
      assert.equal(slots.includes('dsh-mod-providers'), false)
      assert.equal(slots.includes('dsh-mod-hash-files'), hashFileSearch)
      assert.equal(slots.includes('dsh-mod-open-workspace'), openWorkspaceFolder)
      assert.equal(calls.length, openWorkspaceFolder ? 1 : 0)
    })
  }
}

test('invalid feature configuration fails before registering any route', () => {
  assert.throws(() => apply({}, { hashFileSearch: 'false' }), /must be a boolean/)
})
