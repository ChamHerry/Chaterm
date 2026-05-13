<template>
  <a-tooltip
    :title="$t('ai.voiceRecognitionServiceUnavailable')"
    placement="top"
  >
    <a-button
      ref="voiceButton"
      :disabled="true"
      class="voice-button custom-round-button compact-button"
      size="small"
      @click="toggleVoiceInput"
    >
      <img
        src="@/assets/icons/voice.svg"
        alt="voice"
        class="action-icon"
        style="width: 14px; height: 14px"
      />
    </a-button>
  </a-tooltip>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { notification } from 'ant-design-vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

interface Props {
  disabled?: boolean
  autoSendAfterVoice?: boolean
}

defineProps<Props>()

const emit = defineEmits<{
  'transcription-complete': [text: string]
  'transcription-error': [error: string]
}>()

// Template ref used in template
// @ts-expect-error - Template ref, used in template via ref="voiceButton"
const voiceButton = ref<HTMLElement | null>(null)

const toggleVoiceInput = async () => {
  const message = t('ai.voiceRecognitionServiceUnavailable')
  notification.info({
    message: t('ai.voiceRecognitionFailed'),
    description: message,
    duration: 3
  })
  emit('transcription-error', message)
}

defineExpose({
  toggleVoiceInput
})
</script>

<style>
/* Voice button base styles */
.voice-button {
  transition: all 0.3s ease;
}

.voice-button.recording {
  background-color: #ff4d4f;
  border-color: #ff4d4f;
  color: white;
}

/* Recording animation styles */
.recording-animation {
  position: relative;
  width: 18px;
  height: 18px;
}

.pulse {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 8px;
  height: 8px;
  background-color: white;
  border-radius: 50%;
  animation: pulse 1.5s infinite;
}

@keyframes pulse {
  0% {
    transform: translate(-50%, -50%) scale(1);
    opacity: 1;
  }
  50% {
    transform: translate(-50%, -50%) scale(1.5);
    opacity: 0.7;
  }
  100% {
    transform: translate(-50%, -50%) scale(2);
    opacity: 0;
  }
}

/* Button styles copied from parent component */
.custom-round-button {
  height: 18px;
  width: 18px;
  padding: 0;
  border-radius: 4px;
  font-size: 10px;
  background-color: transparent;
  border: none;
  color: var(--text-color);
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
}

.custom-round-button:hover {
  transform: scale(1.15);
  background-color: var(--hover-bg-color);
}

.custom-round-button:active {
  transform: scale(0.95);
  box-shadow: none;
}

.custom-round-button[disabled] {
  cursor: not-allowed;
  opacity: 0.2;
  pointer-events: none;
}

.custom-round-button[disabled]:hover {
  transform: none;
}

/* Ensure icon styles are correct */
.custom-round-button img {
  filter: brightness(1) contrast(1);
  opacity: 1;
}

.custom-round-button .action-icon {
  .theme-dark & {
    filter: none;
  }
  .theme-light & {
    filter: brightness(0) saturate(100%);
    opacity: 0.6;
  }
}

/* Ensure button is properly aligned in container */
.voice-button {
  box-sizing: border-box;
  line-height: 1;
  vertical-align: middle;
  min-height: 18px;
  max-height: 18px;
  align-self: center;
  flex-shrink: 0;
}
</style>
