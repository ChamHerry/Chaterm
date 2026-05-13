<template>
  <div class="userInfo">
    <a-card
      :bordered="false"
      class="userInfo-container"
    >
      <a-form
        :colon="false"
        label-align="left"
        wrapper-align="right"
        :label-col="{ span: 7, offset: 0 }"
        :wrapper-col="{ span: 17, class: 'right-aligned-wrapper' }"
        class="custom-form"
      >
        <a-form-item>
          <template #label>
            <span class="label-text">{{ $t('user.privacy') }}</span>
          </template>
        </a-form-item>
        <a-form-item
          v-if="!telemetryPolicyHidden"
          :label="$t('user.telemetry')"
          class="user_my-ant-form-item"
        >
          <a-radio-group
            v-model:value="userConfig.telemetry"
            class="custom-radio-group"
            @change="updateTelemetry"
          >
            <a-radio value="enabled">{{ $t('user.telemetryEnabled') }}</a-radio>
            <a-radio value="disabled">{{ $t('user.telemetryDisabled') }}</a-radio>
          </a-radio-group>
        </a-form-item>
        <a-form-item
          v-if="!telemetryPolicyHidden"
          class="description-item"
          :label-col="{ span: 0 }"
          :wrapper-col="{ span: 24 }"
        >
          <div class="description">
            {{ $t('user.telemetryDescriptionText') }}
          </div>
        </a-form-item>
        <a-form-item
          :label="$t('user.secretRedaction')"
          class="user_my-ant-form-item"
        >
          <a-radio-group
            v-model:value="userConfig.secretRedaction"
            class="custom-radio-group"
            @change="changeSecretRedaction"
          >
            <a-radio value="enabled">{{ $t('user.secretRedactionEnabled') }}</a-radio>
            <a-radio value="disabled">{{ $t('user.secretRedactionDisabled') }}</a-radio>
          </a-radio-group>
        </a-form-item>
        <a-form-item
          class="description-item"
          :label-col="{ span: 0 }"
          :wrapper-col="{ span: 24 }"
        >
          <div class="description">
            {{ $t('user.secretRedactionDescription') }}
          </div>
          <a-collapse
            v-if="userConfig.secretRedaction === 'enabled'"
            class="patterns-collapse"
            size="small"
            ghost
          >
            <a-collapse-panel
              key="patterns"
              :header="$t('user.supportedPatterns')"
            >
              <div class="patterns-list">
                <div
                  v-for="pattern in secretPatterns"
                  :key="pattern.name"
                  class="pattern-item"
                >
                  <div class="pattern-name">
                    {{ pattern.name }}: <code>{{ pattern.regex }}</code>
                  </div>
                </div>
              </div>
            </a-collapse-panel>
          </a-collapse>
        </a-form-item>
      </a-form>
    </a-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { notification } from 'ant-design-vue'
import { userConfigStore, remoteApplyGuard } from '@/services/userConfigStoreService'
import { useI18n } from 'vue-i18n'
import eventBus from '@/utils/eventBus'
import type { TelemetrySetting } from '@shared/TelemetrySetting'

const logger = createRendererLogger('settings.privacy')
const { t } = useI18n()

const userConfig = ref({
  secretRedaction: 'disabled',
  telemetry: 'enabled'
})

const parsePolicyEnabled = (raw: unknown): boolean | null => {
  if (typeof raw !== 'string') return null
  const normalized = raw.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return null
}
const telemetryPolicyEnabled = parsePolicyEnabled(import.meta.env.RENDERER_TELEMETRY_ENABLED)
const telemetryPolicyHidden = computed(() => telemetryPolicyEnabled === false)

const secretPatterns = computed(() => [
  {
    name: t('user.ipv4Address'),
    regex: '\\b((25[0-5]|(2[0-4]|1\\d|[1-9]|)\\d)\\.?\\b){4}\\b'
  },
  {
    name: t('user.ipv6Address'),
    regex: '\\b((([0-9A-Fa-f]{1,4}:){1,6}:)|(([0-9A-Fa-f]{1,4}:){7}))([0-9A-Fa-f]{1,4})\\b'
  },
  {
    name: t('user.emailAddress'),
    regex: '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}'
  },
  {
    name: t('user.openaiApiKey'),
    regex: '\\bsk-[a-zA-Z0-9]{48}\\b'
  },
  {
    name: t('user.anthropicApiKey'),
    regex: '\\bsk-ant-api\\d{0,2}-[a-zA-Z0-9\\-]{80,120}\\b'
  },
  {
    name: t('user.jsonWebToken'),
    regex: '\\b(ey[a-zA-Z0-9_\\-=]{10,}\\.){2}[a-zA-Z0-9_\\-=]{10,}\\b'
  }
])

const loadSavedConfig = async () => {
  try {
    const savedConfig = await userConfigStore.getConfig()
    if (savedConfig) {
      userConfig.value = {
        secretRedaction: (savedConfig.secretRedaction || 'enabled') as 'enabled' | 'disabled',
        telemetry: ((savedConfig as any).telemetry || 'unset') as 'unset' | 'enabled' | 'disabled'
      } as any
      if (telemetryPolicyEnabled === false) {
        userConfig.value.telemetry = 'disabled'
      }
      await saveConfig()
    }
  } catch (error) {
    logger.error('Failed to load config', { error })
    notification.error({
      message: t('user.loadConfigFailed'),
      description: t('user.loadConfigFailedDescription')
    })
  }
}

const saveConfig = async () => {
  try {
    await userConfigStore.saveConfig({
      secretRedaction: (userConfig.value.secretRedaction || 'enabled') as 'enabled' | 'disabled',
      telemetry: ((userConfig.value as any).telemetry || 'unset') as 'unset' | 'enabled' | 'disabled'
    } as any)
  } catch (error) {
    logger.error('Failed to save config', { error })
    notification.error({
      message: t('user.error'),
      description: t('user.saveConfigFailedDescription')
    })
  }
}

watch(
  () => userConfig.value,
  async () => {
    if (remoteApplyGuard.isApplying) return
    await saveConfig()
  },
  { deep: true }
)

const reloadConfigOnSync = async () => {
  await loadSavedConfig()
}

onMounted(async () => {
  await loadSavedConfig()
  eventBus.on('userConfigSyncApplied', reloadConfigOnSync)
})

onBeforeUnmount(() => {
  eventBus.off('userConfigSyncApplied', reloadConfigOnSync)
})

const updateTelemetry = async () => {
  try {
    if (telemetryPolicyEnabled === false) {
      userConfig.value.telemetry = 'disabled'
    }
    await window.api.sendToMain({
      type: 'telemetrySetting',
      telemetrySetting: userConfig.value.telemetry as TelemetrySetting
    })
    await saveConfig()
  } catch (error) {
    logger.error('Failed to change telemetry setting', { error })
    notification.error({
      message: t('user.telemetryUpdateFailed'),
      description: t('user.telemetryUpdateFailedDescription')
    })
  }
}

const changeSecretRedaction = async () => {
  await saveConfig()
}
</script>

<style scoped>
.userInfo {
  width: 100%;
  height: 100%;
}

.userInfo-container {
  width: 100%;
  height: 100%;
  background-color: var(--bg-color) !important;
  border-radius: 6px;
  overflow: hidden;
  padding: 4px;
  box-shadow: 0 4px 10px rgba(0, 0, 0, 0.15);
  color: var(--text-color);
}

:deep(.ant-card) {
  height: 100%;
  background-color: var(--bg-color) !important;
}

:deep(.ant-card-body) {
  height: 100%;
  display: flex;
  flex-direction: column;
  background-color: var(--bg-color);
}

.custom-form {
  color: var(--text-color);
  align-content: center;
}

.custom-form :deep(.ant-form-item-label) {
  padding-right: 20px;
}

.custom-form :deep(.ant-form-item-label > label) {
  color: var(--text-color);
}

.custom-form :deep(.ant-input),
.custom-form :deep(.ant-input-number),
.custom-form :deep(.ant-radio-wrapper) {
  color: var(--text-color);
}

.custom-form :deep(.ant-input-number) {
  background-color: var(--input-number-bg);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  transition: all 0.3s;
  width: 100px !important;
}

.custom-form :deep(.ant-input-number:hover),
.custom-form :deep(.ant-input-number:focus),
.custom-form :deep(.ant-input-number-focused) {
  background-color: var(--input-number-hover-bg);
  border-color: #1890ff;
  box-shadow: 0 0 0 2px rgba(24, 144, 255, 0.2);
}

.custom-form :deep(.ant-input-number-input) {
  height: 32px;
  padding: 4px 8px;
  background-color: transparent;
  color: var(--text-color);
}

.label-text {
  font-size: 20px;
  font-weight: bold;
  line-height: 1.3;
}

.user_my-ant-form-item {
  -webkit-box-sizing: border-box;
  box-sizing: border-box;
  margin: 0;
  padding: 0;
  color: rgba(0, 0, 0, 0.65);
  font-size: 30px;
  font-variant: tabular-nums;
  line-height: 1.5;
  list-style: none;
  -webkit-font-feature-settings: 'tnum';
  font-feature-settings: 'tnum';
  margin-bottom: 14px;
  vertical-align: top;
  color: #ffffff;
}

.divider-container {
  width: calc(65%);
  margin: -10px calc(16%);
}

:deep(.right-aligned-wrapper) {
  text-align: right;
  color: #ffffff;
}

.checkbox-md :deep(.ant-checkbox-inner) {
  width: 20px;
  height: 20px;
}

.description-item {
  margin-top: -15px;
  margin-bottom: 14px;
}

.patterns-collapse {
  margin-top: 12px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background-color: var(--bg-color-secondary);
}

.patterns-collapse :deep(.ant-collapse-header) {
  background-color: var(--bg-color-secondary);
  color: var(--text-color);
  padding: 8px 12px;
  font-size: 13px;
  font-weight: 500;
}

.patterns-collapse :deep(.ant-collapse-content-box) {
  padding: 12px;
  background-color: var(--bg-color);
}

.patterns-list {
  max-height: 300px;
  overflow-y: auto;
}

.pattern-item {
  margin-bottom: 8px;
  padding: 8px;
  background-color: var(--bg-color-secondary);
  border-radius: 4px;
  border: 1px solid var(--border-color);
}

.pattern-item:last-child {
  margin-bottom: 0;
}

.pattern-name {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-color);
  margin-bottom: 4px;
}

.pattern-name code {
  background-color: var(--bg-color);
  color: var(--text-color-secondary);
  padding: 2px 4px;
  border-radius: 3px;
  font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
  font-size: 10px;
  word-break: break-all;
  border: 1px solid var(--border-color);
}
</style>
