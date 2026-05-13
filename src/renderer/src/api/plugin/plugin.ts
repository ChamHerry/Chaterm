export function listStorePlugins(_params?: unknown) {
  return Promise.resolve({ data: { plugins: [] } })
}

export function listPluginVersions(_pluginKey: string) {
  return Promise.resolve({ data: { versions: [] } })
}

export function getPluginDownload(_pluginKey: string, _version?: string) {
  return Promise.reject(new Error('Remote plugin store was removed in YiXin-only local mode'))
}

export function getPluginIconUrl(_pluginKey: string, _version?: string): Promise<string> {
  return Promise.resolve('')
}
