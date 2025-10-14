import type { PluginContext, PluginResponse } from '../types/index.js'

export type PluginHandler = (payload: PluginContext) => Promise<PluginResponse>

const registry = new Map<string, PluginHandler>()

export function registerPlugin(name: string, handler: PluginHandler) {
  registry.set(name, handler)
}

export function getPlugin(name: string): PluginHandler | undefined {
  return registry.get(name)
}
