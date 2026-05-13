<template>
  <a-tooltip
    :title="$t('ai.startVoiceInput')"
    placement="top"
  >
    <a-button
      disabled
      :class="['voice-button', 'custom-round-button', 'compact-button']"
      size="small"
    >
      <img
        src="@/assets/icons/voice.svg"
        alt="voice"
        style="width: 14px; height: 14px"
      />
    </a-button>
  </a-tooltip>
</template>

<script setup lang="ts">
interface Props {
  disabled?: boolean
}

defineProps<Props>()

defineEmits<{
  'transcription-complete': [text: string]
  'transcription-update': [text: string]
  'transcription-error': [error: string]
  'recording-stop': []
}>()
</script>

<style>
.voice-button {
  transition: all 0.3s ease;
}

.custom-round-button {
  height: 18px;
  width: 18px;
  padding: 0;
  border-radius: 50%;
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

.custom-round-button[disabled] {
  cursor: not-allowed;
  opacity: 0.2;
  pointer-events: none;
}

.custom-round-button img {
  filter: brightness(1) contrast(1);
  opacity: 1;
}
</style>
