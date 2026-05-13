import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const dir = dirname(fileURLToPath(import.meta.url))
const usePluginsSource = readFileSync(resolve(dir, '../usePlugins.ts'), 'utf8')
const indexSource = readFileSync(resolve(dir, '../index.vue'), 'utf8')
const detailSource = readFileSync(resolve(dir, '../pluginDetail.vue'), 'utf8')

describe('Extensions YiXin-only local plugin contract', () => {
  it('does not import the legacy Chaterm plugin store API', () => {
    const combined = `${usePluginsSource}\n${indexSource}\n${detailSource}`

    expect(combined).not.toContain('@/api/plugin/plugin')
    expect(combined).not.toContain('listStorePlugins')
    expect(combined).not.toContain('listPluginVersions')
    expect(combined).not.toContain('getPluginDownload')
    expect(combined).not.toContain('getPluginIconUrl')
  })

  it('keeps plugin discovery local to installed/preinstalled plugins', () => {
    expect(usePluginsSource).toContain('api.listPlugins')
    expect(usePluginsSource).toContain('storePlugins.value = []')
    expect(indexSource).toContain('api.installPlugin(filePath)')
    expect(detailSource).toContain('api.getPluginDetails(name)')
  })
})
