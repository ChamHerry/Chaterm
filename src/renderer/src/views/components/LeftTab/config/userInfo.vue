<template>
  <div class="userInfo">
    <a-card
      :bordered="false"
      class="userInfo-container"
    >
      <div class="user_avatar">
        <img
          :src="userInfo.avatar"
          referrerpolicy="no-referrer"
          alt=""
        />
      </div>
      <div class="registration_type">
        {{ t('userInfo.personal') }}
      </div>
      <div class="divider-container">
        <a-divider style="border-color: var(--border-color-light, #e8e8e8); margin-bottom: 20px" />
      </div>

      <a-form
        :label-col="{ span: 10, offset: 2 }"
        :wrapper-col="{ span: 12 }"
        class="custom-form"
      >
        <a-form-item
          label="UID"
          class="user_my-ant-form-item"
        >
          <span class="field-selectable">{{ userInfo.uid ?? '-' }}</span>
        </a-form-item>
        <a-form-item
          :label="t('userInfo.name')"
          class="user_my-ant-form-item"
        >
          <span class="field-selectable">{{ userInfo.name || '-' }}</span>
        </a-form-item>
        <a-form-item
          :label="t('userInfo.email')"
          class="user_my-ant-form-item"
        >
          <span class="field-selectable">{{ userInfo.email || '-' }}</span>
        </a-form-item>
      </a-form>
    </a-card>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import i18n from '@/locales'
import { getUserInfo as getLocalUserInfo } from '@/utils/permission'

const { t } = i18n.global
const userInfo = ref<{ uid?: number; name?: string; email?: string; avatar?: string }>({})

const loadUserInfo = () => {
  const localUser = getLocalUserInfo()
  if (localUser) {
    userInfo.value = {
      uid: localUser.uid,
      name: localUser.name,
      email: localUser.email,
      avatar: localUser.avatar
    }
  }
}

onMounted(() => {
  loadUserInfo()
})
</script>

<style lang="less" scoped>
.userInfo {
  width: 100%;
  height: 100%;
  overflow: hidden;
  border-right: none;
}

.userInfo-container {
  width: 100%;
  height: 100%;
  background-color: var(--bg-color);
  border-radius: 6px;
  overflow: hidden;
  padding: 4px;
  box-shadow: none;
  color: var(--text-color);
  border: none;
  position: relative;
}

:deep(.ant-card) {
  height: 100%;
  background-color: var(--bg-color);
  border: none;
  box-shadow: none;
}

:deep(.ant-card-body) {
  border: none;
}

:deep(.ant-card-body) {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  overflow-y: auto;
  border: none;
  scrollbar-width: thin;
  scrollbar-color: var(--scrollbar-thumb-color, rgba(0, 0, 0, 0.2)) transparent;
}

:deep(.ant-card-body)::-webkit-scrollbar {
  width: 6px;
}

:deep(.ant-card-body)::-webkit-scrollbar-track {
  background: transparent;
}

:deep(.ant-card-body)::-webkit-scrollbar-thumb {
  background-color: var(--scrollbar-thumb-color, rgba(0, 0, 0, 0.2));
  border-radius: 3px;
}

.custom-form {
  position: relative;
  color: var(--text-color);
  align-content: center;
  width: 100%;
}

.field-selectable {
  cursor: text;
  user-select: text;
  -webkit-user-select: text;
}

.custom-form :deep(.ant-form-item-label) {
  padding-right: 1px;
}

.custom-form :deep(.ant-form-item-label > label) {
  color: var(--text-color);
}

.user_my-ant-form-item {
  -webkit-box-sizing: border-box;
  box-sizing: border-box;
  margin: 0;
  padding: 0;
  color: var(--text-color);
  font-size: 30px;
  font-variant: tabular-nums;
  line-height: 1.5;
  list-style: none;
  -webkit-font-feature-settings: 'tnum';
  font-feature-settings: 'tnum';
  margin-bottom: 8px;
  vertical-align: top;
  width: 100%;
}

.custom-form :deep(.ant-form-item) {
  margin-bottom: 8px;
}

.user_avatar {
  width: 18vmin;
  height: 18vmin;
  margin: 0 auto 20px;
  border-radius: 50%;
  overflow: hidden;
  position: relative;
  flex-shrink: 0;
}

.user_avatar img {
  position: absolute;
  width: 100%;
  height: 100%;
  object-fit: cover;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
}

@media (max-width: 768px) {
  .user_avatar {
    width: 20vmin;
    height: 20vmin;
  }
}

.registration_type {
  text-align: center;
  font-weight: bold;
}

.divider-container {
  position: relative;
  width: 70%;
  margin: 0 auto;
  text-align: center;
}

.divider-container :deep(.ant-divider) {
  border-color: var(--border-color-light);
}
</style>
