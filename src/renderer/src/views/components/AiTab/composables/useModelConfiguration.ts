import { ref, watch, computed } from 'vue'
import { createGlobalState } from '@vueuse/core'
import { getGlobalState, updateGlobalState, storeSecret, getSecret } from '@renderer/agent/storage/state'

const logger = createRendererLogger('ai.modelConfig')
import { GlobalStateKey, SecretKey } from '@renderer/agent/storage/state-keys'
import { focusChatInput } from './useTabManagement'
import { useSessionState } from './useSessionState'
import eventBus from '@/utils/eventBus'

interface ModelSelectOption {
  label: string
  value: string
}

interface ModelOption {
  id: string
  name: string
  checked: boolean
  type: string
  apiProvider: string
}

const isEmptyValue = (value: unknown): boolean => value === undefined || value === ''
const ENTERPRISE_MODEL_ID_PREFIX = 'enterprise:'
const ENTERPRISE_RUNTIME_GLOBAL_KEYS: GlobalStateKey[] = [
  'apiProvider',
  'apiModelId',
  'awsRegion',
  'awsUseCrossRegionInference',
  'awsBedrockEndpoint',
  'awsEndpointSelected',
  'openAiBaseUrl',
  'openAiModelId',
  'openAiModelInfo',
  'ollamaModelId',
  'ollamaBaseUrl',
  'anthropicBaseUrl',
  'anthropicModelId',
  'liteLlmBaseUrl',
  'liteLlmModelId'
]
const ENTERPRISE_RUNTIME_SECRET_KEYS: SecretKey[] = [
  'awsAccessKey',
  'awsSecretKey',
  'awsSessionToken',
  'openAiApiKey',
  'deepSeekApiKey',
  'anthropicApiKey',
  'liteLlmApiKey'
]

let enterpriseSyncTimer: ReturnType<typeof setInterval> | null = null

function parseDeployStatus(raw: unknown): number {
  if (typeof raw !== 'string') return 0
  const normalized = raw.trim()
  if (!normalized) return 0
  const parsed = Number(normalized)
  if (!Number.isFinite(parsed)) return 0
  return parsed
}

export function isEnterpriseDeployEnabled(): boolean {
  return parseDeployStatus(import.meta.env.RENDERER_DEPLOY_STATUS) === 1
}

function isEnterpriseModelOption(model: Pick<ModelOption, 'id'> | undefined): boolean {
  return Boolean(model?.id && String(model.id).startsWith(ENTERPRISE_MODEL_ID_PREFIX))
}

function clearEnterpriseSyncTimer(): void {
  if (!enterpriseSyncTimer) return
  clearInterval(enterpriseSyncTimer)
  enterpriseSyncTimer = null
}

async function removeEnterpriseModelOptions(): Promise<void> {
  const savedModelOptions = (((await getGlobalState('modelOptions')) || []) as ModelOption[]).filter((option) => !isEnterpriseModelOption(option))
  await updateGlobalState('modelOptions', savedModelOptions)
  eventBus.emit('SettingModelOptionsChanged')
}

async function clearEnterpriseRuntimeConfiguration(): Promise<void> {
  for (const key of ENTERPRISE_RUNTIME_GLOBAL_KEYS) {
    await updateGlobalState(key, undefined)
  }
  for (const key of ENTERPRISE_RUNTIME_SECRET_KEYS) {
    await storeSecret(key, undefined)
  }
}

async function cleanupEnterpriseManagedState(options: { preserveConfigs: boolean; clearRuntimeConfiguration?: boolean }): Promise<void> {
  clearEnterpriseSyncTimer()

  const savedModelOptions = (((await getGlobalState('modelOptions')) || []) as ModelOption[]) || []
  if (savedModelOptions.some((option) => isEnterpriseModelOption(option))) {
    await removeEnterpriseModelOptions()
  }

  if (options.clearRuntimeConfiguration !== false) {
    await clearEnterpriseRuntimeConfiguration()
  }
  await updateGlobalState('enterpriseModelPluginActive', false)
  await updateGlobalState('enterpriseModelPluginResolvedSignature', '')
  if (!options.preserveConfigs) {
    await updateGlobalState('enterpriseModelConfigs', [])
    await updateGlobalState('enterpriseModelConfigVersion', '')
  }
}

async function resetEnterpriseState(): Promise<void> {
  await cleanupEnterpriseManagedState({ preserveConfigs: false, clearRuntimeConfiguration: false })
}

export async function syncEnterpriseStateFromUserData(_userData: unknown, _options: { reloadPlugins?: boolean } = {}): Promise<[]> {
  if (!isEnterpriseDeployEnabled()) {
    await resetEnterpriseState()
    return []
  }
  return []
}

/**
 * Mapping from API provider to corresponding model ID global state key
 */
export const PROVIDER_MODEL_KEY_MAP: Record<string, GlobalStateKey> = {
  anthropic: 'anthropicModelId',
  bedrock: 'apiModelId',
  litellm: 'liteLlmModelId',
  deepseek: 'apiModelId',
  openai: 'openAiModelId',
  ollama: 'ollamaModelId',
  default: 'defaultModelId'
}

/**
 * Composable for AI model configuration management
 * Handles model selection, configuration and initialization
 */
export const useModelConfiguration = createGlobalState(() => {
  const { chatAiModelValue } = useSessionState()

  const AgentAiModelsOptions = ref<ModelSelectOption[]>([])
  const lockedModels = ref<string[]>([])
  const allLockedNames = ref<string[]>([])
  const budgetResetAt = ref<string>('')
  const subscription = ref<string>('')
  const modelsLoading = ref(true)

  const handleChatAiModelChange = async () => {
    const modelOptions = ((await getGlobalState('modelOptions')) as ModelOption[]) || []
    const selectedModel = modelOptions.find((model) => model.name === chatAiModelValue.value)

    if (selectedModel && selectedModel.apiProvider) {
      await updateGlobalState('apiProvider', selectedModel.apiProvider)
    }

    const apiProvider = selectedModel?.apiProvider
    const key = PROVIDER_MODEL_KEY_MAP[apiProvider || 'default'] || 'defaultModelId'
    await updateGlobalState(key, chatAiModelValue.value)

    focusChatInput()
  }

  const initModel = async () => {
    try {
      const modelOptions = ((await getGlobalState('modelOptions')) || []) as ModelOption[]

      modelOptions.sort((a, b) => {
        const aIsThinking = a.name.endsWith('-Thinking')
        const bIsThinking = b.name.endsWith('-Thinking')

        if (aIsThinking && !bIsThinking) return -1
        if (!aIsThinking && bIsThinking) return 1

        return a.name.localeCompare(b.name)
      })

      lockedModels.value = allLockedNames.value.filter((name) => {
        const opt = modelOptions.find((o) => o.name === name)
        return opt && opt.checked
      })
      const lockedSet = new Set(lockedModels.value)
      AgentAiModelsOptions.value = modelOptions
        .filter((item) => item.checked && !lockedSet.has(item.name))
        .map((item) => ({
          label: item.name,
          value: item.name
        }))

      const availableModelNames = AgentAiModelsOptions.value.map((option) => option.value)

      if (availableModelNames.length === 0) {
        return
      }

      let targetModel: string | undefined

      if (chatAiModelValue.value && availableModelNames.includes(chatAiModelValue.value)) {
        targetModel = chatAiModelValue.value
      } else {
        const apiProvider = (await getGlobalState('apiProvider')) as string
        const key = PROVIDER_MODEL_KEY_MAP[apiProvider || 'default'] || 'defaultModelId'
        const storedModelId = (await getGlobalState(key)) as string

        if (storedModelId && availableModelNames.includes(storedModelId)) {
          targetModel = storedModelId
        } else {
          targetModel = AgentAiModelsOptions.value[0]?.label
        }
      }

      if (!targetModel) {
        return
      }

      if (chatAiModelValue.value !== targetModel) {
        chatAiModelValue.value = targetModel
      }
      await handleChatAiModelChange()
    } finally {
      modelsLoading.value = false
    }
  }

  const checkModelConfig = async (): Promise<{ success: boolean; message?: string; description?: string }> => {
    // Check if there are any available models
    const modelOptions = (await getGlobalState('modelOptions')) as ModelOption[]
    const availableModels = modelOptions.filter((model) => model.checked)

    if (availableModels.length === 0) {
      return {
        success: false,
        message: 'user.noAvailableModelMessage',
        description: 'user.noAvailableModelDescription'
      }
    }

    const apiProvider = (await getGlobalState('apiProvider')) as string

    switch (apiProvider) {
      case 'bedrock':
        const awsAccessKey = await getSecret('awsAccessKey')
        const awsSecretKey = await getSecret('awsSecretKey')
        const awsRegion = await getGlobalState('awsRegion')
        const apiModelId = await getGlobalState('apiModelId')
        if (isEmptyValue(apiModelId) || isEmptyValue(awsAccessKey) || isEmptyValue(awsSecretKey) || isEmptyValue(awsRegion)) {
          return {
            success: false,
            message: 'user.checkModelConfigFailMessage',
            description: 'user.checkModelConfigFailDescription'
          }
        }
        break
      case 'litellm':
        const liteLlmBaseUrl = await getGlobalState('liteLlmBaseUrl')
        const liteLlmApiKey = await getSecret('liteLlmApiKey')
        const liteLlmModelId = await getGlobalState('liteLlmModelId')
        if (isEmptyValue(liteLlmBaseUrl) || isEmptyValue(liteLlmApiKey) || isEmptyValue(liteLlmModelId)) {
          return {
            success: false,
            message: 'user.checkModelConfigFailMessage',
            description: 'user.checkModelConfigFailDescription'
          }
        }
        break
      case 'deepseek':
        const deepSeekApiKey = await getSecret('deepSeekApiKey')
        const apiModelIdDeepSeek = await getGlobalState('apiModelId')
        if (isEmptyValue(deepSeekApiKey) || isEmptyValue(apiModelIdDeepSeek)) {
          return {
            success: false,
            message: 'user.checkModelConfigFailMessage',
            description: 'user.checkModelConfigFailDescription'
          }
        }
        break
      case 'openai':
        const openAiBaseUrl = await getGlobalState('openAiBaseUrl')
        const openAiApiKey = await getSecret('openAiApiKey')
        const openAiModelId = await getGlobalState('openAiModelId')
        if (isEmptyValue(openAiBaseUrl) || isEmptyValue(openAiApiKey) || isEmptyValue(openAiModelId)) {
          return {
            success: false,
            message: 'user.checkModelConfigFailMessage',
            description: 'user.checkModelConfigFailDescription'
          }
        }
        break
      case 'anthropic':
        const anthropicApiKey = await getSecret('anthropicApiKey')
        const anthropicModelId = await getGlobalState('anthropicModelId')
        if (isEmptyValue(anthropicApiKey) || isEmptyValue(anthropicModelId)) {
          return {
            success: false,
            message: 'user.checkModelConfigFailMessage',
            description: 'user.checkModelConfigFailDescription'
          }
        }
        break
    }
    return { success: true }
  }

  const initModelOptions = async () => {
    try {
      modelsLoading.value = true
      await syncEnterpriseStateFromUserData({}, { reloadPlugins: true })

      const savedModelOptions = ((await getGlobalState('modelOptions')) || []) as ModelOption[]
      if (savedModelOptions.length === 0) {
        modelsLoading.value = false
        return
      }

      await initModel()
    } catch (error) {
      logger.error('Failed to init model options', { error: error })
      modelsLoading.value = false
    }
  }

  const refreshModelOptions = async (): Promise<void> => {
    try {
      await syncEnterpriseStateFromUserData({}, { reloadPlugins: true })
    } catch (error) {
      logger.error('Failed to refresh model options', { error: error })
      return
    }

    await initModel()
  }

  // Check if there are available models
  const hasAvailableModels = computed(() => {
    if (modelsLoading.value) {
      return true
    }
    return AgentAiModelsOptions.value && AgentAiModelsOptions.value.length > 0
  })

  // Auto-switch to first available model when selected model is locked or invalid
  watch(
    [AgentAiModelsOptions, lockedModels],
    ([newOptions, newLocked]) => {
      if (newOptions.length > 0) {
        const current = chatAiModelValue.value
        const isInAvailable = newOptions.some((opt) => opt.value === current)
        const isInLocked = (newLocked || []).includes(current)
        const isInvalid = !current || !isInAvailable || isInLocked
        if (isInvalid && newOptions[0]) {
          chatAiModelValue.value = newOptions[0].value
          handleChatAiModelChange()
        }
      }
    },
    { immediate: true }
  )

  const showLockedModelUpgradeTag = computed(() => {
    const sub = (subscription.value || '').toLowerCase()
    return sub === 'free' || sub === 'lite'
  })

  return {
    AgentAiModelsOptions,
    lockedModels,
    budgetResetAt,
    showLockedModelUpgradeTag,
    modelsLoading,
    hasAvailableModels,
    initModel,
    handleChatAiModelChange,
    checkModelConfig,
    initModelOptions,
    refreshModelOptions
  }
})
