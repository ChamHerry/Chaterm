<template>
  <div class="term_login">
    <div class="connetus">
      <a-dropdown overlay-class-name="app-region-no-drag">
        <a
          class="ant-dropdown-link"
          @click.prevent
        >
          <GlobalOutlined />
        </a>
        <template #overlay>
          <a-menu @click="configLang">
            <a-menu-item
              v-for="item in config.LANG"
              :key="item.value"
              >{{ item.name }}
            </a-menu-item>
          </a-menu>
        </template>
      </a-dropdown>
      <TitleBar variant="login" />
    </div>
    <div class="term_login_content">
      <div>
        <img
          src="@/assets/logo.svg"
          class="logo"
          alt=""
        />
      </div>
      <div class="term_login_welcome">
        <span>{{ $t('login.welcome') }}</span>
        <span style="color: #2a82e4; margin-left: 12px">{{ isChineseEdition() ? 'Chaterm CN' : $t('login.title') }}</span>
      </div>
      <div class="term_login_input">
        <div class="yixin-login-section">
          <button
            class="login-btn primary yixin-login-btn"
            :disabled="externalLoginLoading"
            @click="handleYixinLogin"
          >
            <span
              v-if="externalLoginLoading"
              class="loading-spinner"
            ></span>
            {{ $t('login.yixinLogin') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useRouter } from 'vue-router'
import { onBeforeUnmount, onMounted, nextTick, ref } from 'vue'
import { GlobalOutlined } from '@ant-design/icons-vue'
import type { MenuProps } from 'ant-design-vue'
import { message } from 'ant-design-vue'
import { captureButtonClick, LoginFailureReasons, LoginFunnelEvents, LoginMethods } from '@/utils/telemetry'
import { shortcutService } from '@/services/shortcutService'
import { setCurrentYixinSession, type YixinSessionUserInfo } from '@/services/yixinSessionService'
import config from '@renderer/config'
import { useI18n } from 'vue-i18n'
import { isChineseEdition } from '@/utils/edition'
import TitleBar from '@views/components/Header/titleBar.vue'

const logger = createRendererLogger('auth.login')
const { t, locale } = useI18n()
const router = useRouter()
const externalLoginLoading = ref(false)

const configLang: MenuProps['onClick'] = ({ key }) => {
  const lang = String(key)
  locale.value = lang
  localStorage.setItem('lang', lang)
}

const handleYixinLogin = async () => {
  try {
    externalLoginLoading.value = true
    await captureButtonClick(LoginFunnelEvents.CLICK_LOGIN_BUTTON, {
      method: LoginMethods.SSO
    })
    const api = window.api as any
    const result = api.openYixinLogin ? await api.openYixinLogin() : await api.openExternalLogin()
    if (result?.success === false) {
      throw new Error(result.error || t('login.externalLoginFailed'))
    }
  } catch (err) {
    logger.error('Start YiXin login failed', { error: err })
    message.error(err instanceof Error ? err.message : t('login.externalLoginFailed'))
    await captureButtonClick(LoginFunnelEvents.LOGIN_FAILED, {
      method: LoginMethods.SSO,
      failure_reason: LoginFailureReasons.UNKNOWN_ERROR,
      error_message: err instanceof Error ? err.message : String(err)
    })
  } finally {
    externalLoginLoading.value = false
  }
}

const handleExternalLoginError = async (_event: unknown, data: { error?: string }) => {
  const errorMessage = data?.error || t('login.externalLoginFailed')
  logger.error('YiXin login error', { error: errorMessage })
  message.error(errorMessage)
  await captureButtonClick(LoginFunnelEvents.LOGIN_FAILED, {
    method: LoginMethods.SSO,
    failure_reason: LoginFailureReasons.UNKNOWN_ERROR,
    error_message: errorMessage
  })
}

const handleExternalLoginSuccess = async (_event: unknown, data: { userInfo?: YixinSessionUserInfo; method?: string }) => {
  const { userInfo, method = LoginMethods.SSO } = data
  if (!userInfo?.token || !userInfo?.uid) {
    message.error(t('login.loginProcessFailed'))
    return
  }

  try {
    setCurrentYixinSession(userInfo)

    const api = window.api as any
    const dbResult = await api.initUserDatabase({ uid: userInfo.uid })
    if (!dbResult.success) {
      logger.error('Database initialization failed', { error: dbResult.error })
      await captureButtonClick(LoginFunnelEvents.LOGIN_FAILED, {
        method,
        failure_reason: LoginFailureReasons.DATABASE_ERROR,
        error_message: dbResult.error
      })
      message.error(t('login.databaseInitFailed'))
      return
    }

    shortcutService.init()
    await captureButtonClick(LoginFunnelEvents.LOGIN_SUCCESS, { method })
    await nextTick()
    await router.replace('/')
  } catch (error) {
    logger.error('YiXin login handling failed', { error })
    message.error(t('login.loginProcessFailed'))
    await captureButtonClick(LoginFunnelEvents.LOGIN_FAILED, {
      method,
      failure_reason: LoginFailureReasons.UNKNOWN_ERROR,
      error_message: error instanceof Error ? error.message : String(error)
    })
  }
}

onMounted(async () => {
  const api = window.api as any
  api.mainWindowShow()
  await captureButtonClick(LoginFunnelEvents.ENTER_LOGIN_PAGE)

  const ipcRenderer = (window as any).electron?.ipcRenderer
  ipcRenderer?.on('external-login-error', handleExternalLoginError)
  ipcRenderer?.on('external-login-success', handleExternalLoginSuccess)
})

onBeforeUnmount(() => {
  const ipcRenderer = (window as any).electron?.ipcRenderer
  ipcRenderer?.removeListener?.('external-login-success', handleExternalLoginSuccess)
  ipcRenderer?.removeListener?.('external-login-error', handleExternalLoginError)
})
</script>

<style lang="less" scoped>
.term_login {
  position: relative;
  width: 100%;
  height: 100%;
  background: url(@/assets/img/loginBg.png);
  background-repeat: no-repeat;
  background-position: center;
  background-attachment: fixed;
  background-size: cover;
  display: flex;
  align-items: center;
  justify-content: center;
  -webkit-app-region: drag;

  .term_login_content {
    width: 430px;
    height: 480px;
    background: transparent;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    -webkit-app-region: no-drag;
  }

  .yixin-login-section {
    width: 100%;
    margin-bottom: 16px;

    .yixin-login-btn {
      width: 100%;
    }
  }

  .login-divider {
    display: flex;
    align-items: center;
    margin: 12px 0;
    color: rgba(255, 255, 255, 0.45);
    font-size: 13px;

    &::before,
    &::after {
      content: '';
      flex: 1;
      height: 1px;
      background: rgba(255, 255, 255, 0.15);
    }

    span {
      padding: 0 12px;
    }
  }

  .logo {
    width: 100px;
    height: 100px;

    &:hover {
      transform: scale(1.05);
      filter: drop-shadow(0 6px 12px rgba(0, 0, 0, 0.3));
    }
  }

  .login-button {
    margin-top: 20px;
    margin-left: 50%;
    transform: translateX(-50%);
    border-radius: 6px;
    width: 220px;
    height: 36px;
    font-size: 16px;
    border: none;
    transition: all 0.3s ease;
    box-shadow: 0 2px 8px rgba(42, 130, 228, 0.3);

    &:hover {
      background-color: #1677ff;
      transform: translateX(-50%) translateY(-2px);
      box-shadow: 0 4px 12px rgba(42, 130, 228, 0.4);
    }

    &:active {
      transform: translateX(-50%) translateY(0);
      box-shadow: 0 2px 4px rgba(42, 130, 228, 0.3);
    }
  }

  .connetus {
    position: absolute;
    display: flex;
    top: 5px;
    right: 0px;
    height: 20px;
    color: #dddddd;
    font-size: 16px;
    -webkit-app-region: no-drag;

    .ant-dropdown-link {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 40px;
      height: 100%;

      .anticon {
        font-size: 18px;
        color: #dddddd;
        transition: all 0.3s ease;

        &:hover {
          color: #ffffff;
          transform: scale(1.1);
        }
      }
    }
  }

  .term_login_type {
    margin-top: 8px;
  }

  .term_login_welcome {
    font-size: 32px;
    font-weight: bolder;
    letter-spacing: 1px;
    white-space: nowrap;
    background: linear-gradient(135deg, #00eaff 0%, #1677ff 50%, #2a82e4 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
  }

  .term_login_input {
    margin-top: 20px;
    width: 100%;
  }

  .email-login-form {
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
  }

  .email-form-item {
    width: 100%;
    margin-bottom: 18px;
    display: flex;
    justify-content: center;
  }

  .input-row {
    width: 300px;
    border-bottom: 1px solid #6b6b6b;
    margin-bottom: 2px;
    display: flex;
    align-items: center;
  }

  .form-input {
    width: 100%;
    height: 40px;
    background: transparent;
    color: #fff;
    border: none !important;
    border-radius: 0;
    font-size: 16px;
    box-shadow: none !important;
    transition: border-color 0.3s;

    &::placeholder {
      color: #999;
      font-size: 13px;
    }
  }

  .code-row {
    display: flex;
    align-items: center;
    width: 300px;
    border-bottom: 1px solid #6b6b6b;
    margin-bottom: 2px;
  }

  .code-input {
    flex: 1;
    min-width: 0;
    border: none !important;
    box-shadow: none !important;
    background: transparent;
  }

  .code-btn {
    margin-left: 12px;
    min-width: 90px;
    height: 40px;
    font-size: 14px;
    color: #2a82e4;
    background: transparent;
    border: none;
    border-radius: 4px;
    transition: all 0.3s;
    box-shadow: none;
    align-self: stretch;
    display: flex;
    align-items: center;

    &:hover:not(:disabled) {
      color: #40a9ff;
      background: rgba(64, 156, 255, 0.08);
    }

    &:disabled {
      color: #999;
      background: transparent;
      cursor: not-allowed;
    }
  }

  .login-btn {
    width: 320px;
    height: 36px;
    font-size: 16px;
    background-color: #2a82e4;
    border-radius: 6px;
    margin-left: 50%;
    transform: translateX(-50%);
    font-weight: 500;
    letter-spacing: 1px;
  }

  // Base styles

  :deep(.ant-input-affix-wrapper) {
    border: none !important;
    border-bottom: 1px solid #6b6b6b !important;
    border-radius: 0;
    background-color: transparent;
    transition: border-color 0.3s;
    color: #fff;

    .ant-input {
      border: none !important;
      border-bottom: 1px solid #d9d9d9;
      border-radius: 0;
      background-color: transparent;
      transition: border-color 0.3s;
      color: #fff;

      &:focus {
        border-bottom: 1px solid #1890ff;
        box-shadow: none;
        outline: none;
      }

      &:hover {
        border-bottom-color: #1890ff;
      }

      &::placeholder {
        color: #999;
      }
    }
  }

  .ant-input-affix-wrapper-focused {
    box-shadow: none !important;
  }

  &.ant-input[disabled] {
    background-color: transparent;
    border-bottom-color: #d9d9d9;
    color: rgba(0, 0, 0, 0.25);
  }

  .ant-form-item-has-error :not(.ant-input-disabled):not(.ant-input-borderless).ant-input,
  .ant-form-item-has-error :not(.ant-input-affix-wrapper-disabled):not(.ant-input-affix-wrapper-borderless).ant-input-affix-wrapper,
  .ant-form-item-has-error
    :not(.ant-input-number-affix-wrapper-disabled):not(.ant-input-number-affix-wrapper-borderless).ant-input-number-affix-wrapper,
  .ant-form-item-has-error :not(.ant-input-disabled):not(.ant-input-borderless).ant-input:hover,
  .ant-form-item-has-error :not(.ant-input-affix-wrapper-disabled):not(.ant-input-affix-wrapper-borderless).ant-input-affix-wrapper:hover,
  .ant-form-item-has-error
    :not(.ant-input-number-affix-wrapper-disabled):not(.ant-input-number-affix-wrapper-borderless).ant-input-number-affix-wrapper:hover {
    background-color: transparent !important;
  }

  :deep(input) {
    background-color: transparent !important;
    margin-left: 8px;
    letter-spacing: 1px;
  }

  :deep(.ant-input-password-icon) {
    color: #fff !important;
  }

  .term_login_type_radio {
    background-color: #40a9ff;
    border-radius: 6px;

    :deep(.ant-radio-button-wrapper) {
      width: 100px;
      text-align: center;
      border-radius: 6px;
    }
  }

  .term_login_type_radio {
    width: 200px;
    height: 36px;
    background-color: #4c5ee0;
    color: #fff;
    border-radius: 6px;
    border: 1px solid #88a5fc;
    display: flex;
    padding: 1px;

    .term_login_type_radio_type {
      display: inline-block;
      width: 50%;
      border: none;
      background-color: #4c5ee0;
      border-radius: 8px;
      text-align: center;
      line-height: 34px;
    }

    .radio_active {
      background-color: #fff;
      color: #4c5ee0;
    }
  }

  .logo_des {
    width: 20px;
    height: 15px;
    color: #fff;
  }

  .skip-login {
    text-align: center;
    margin-top: 16px;
    color: #949494;

    .skip-link {
      color: #48688e;
      text-decoration: none;
      margin-left: 4px;

      &:hover {
        text-decoration: underline;
      }
    }
  }
}

:deep(.ant-tabs) {
  .ant-tabs-nav {
    margin-bottom: 24px;

    &::before {
      border-bottom: 1px solid rgba(255, 255, 255, 0.2);
    }

    .ant-tabs-tab {
      color: #e0ebff;

      &:hover {
        color: #2a82e4;
      }

      &.ant-tabs-tab-active .ant-tabs-tab-btn {
        color: #2a82e4;
      }
    }

    .ant-tabs-ink-bar {
      background: #2a82e4;
    }
  }
}

:deep(.ant-input-affix-wrapper) {
  .ant-input-suffix {
    .ant-btn-link {
      color: #2a82e4;

      &:hover {
        color: #40a9ff;
      }

      &:disabled {
        color: rgba(255, 255, 255, 0.3);
      }
    }
  }
}

.input-group {
  display: flex;
  flex-direction: column;
  gap: 0;
  width: 320px;
  margin: 0 auto;
}

.input-field {
  position: relative;
  display: flex;
  align-items: center;
  padding: 0 8px;
  height: 44px;
  background: transparent;
  border: none;
  border-bottom: 1px solid rgba(255, 255, 255, 0.2);
  transition: all 0.3s ease;
}

.input-field:focus-within {
  border-bottom-color: #409cff;
}

.input-icon {
  font-size: 16px;
  color: rgba(255, 255, 255, 0.6);
  margin-right: 12px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
}

.mobile-prefix {
  color: rgba(255, 255, 255, 0.8);
  font-size: 14px;
  margin-right: 16px;
  flex-shrink: 0;
  user-select: none;
}

.mobile-input {
  padding-left: 0;
}

.form-input {
  flex: 1;
  background: transparent !important;
  border: none !important;
  outline: none;
  color: #ffffff;
  font-size: 14px;
  height: 100%;
  box-shadow: none !important;
  -webkit-appearance: none;
  -moz-appearance: none;
  appearance: none;
}

.form-input::placeholder {
  color: rgba(255, 255, 255, 0.4);
}

.code-btn {
  background: transparent;
  border: none;
  color: #409cff;
  font-size: 14px;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;
  transition: all 0.3s ease;
  white-space: nowrap;
}

.code-btn:hover:not(:disabled) {
  background: rgba(64, 156, 255, 0.1);
}

.code-btn:disabled {
  color: rgba(255, 255, 255, 0.3);
  cursor: not-allowed;
}

.input-divider {
  height: 1px;
  background: rgba(255, 255, 255, 0.2);
  margin: 0;
}

.login-btn {
  width: 320px;
  height: 38px;
  border-radius: 8px;
  font-size: 16px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.3s ease;
  border: none;
  outline: none;
  margin: 24px auto 0 auto;
  display: block;
}

.login-btn.primary {
  background: #409cff;
  color: #ffffff;
  border-radius: 6px;
}

.login-btn.primary:hover:not(:disabled) {
  background: #337ecc;
}

.login-btn.primary:disabled {
  background: rgba(64, 156, 255, 0.5);
  cursor: not-allowed;
}

// Loading spinner styles
.loading-spinner {
  display: inline-block;
  width: 16px;
  height: 16px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-radius: 50%;
  border-top-color: #ffffff;
  animation: spin 1s ease-in-out infinite;
  margin-right: 8px;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.login-btn {
  display: flex;
  align-items: center;
  justify-content: center;
}

// Tab switch styles - reference design styles
.login-tabs {
  display: flex;
  width: 320px;
  margin: 0 auto 20px auto;
  background: transparent;
  border-radius: 0;
  padding: 0;
  position: relative;
}

.tab-item {
  flex: 1;
  text-align: center;
  padding: 12px 12px;
  cursor: pointer;
  transition: all 0.3s ease;
  color: rgba(255, 255, 255, 0.6);
  font-size: 16px;
  font-weight: 400;
  user-select: none;
  position: relative;
  border-bottom: 2px solid transparent;

  &:hover {
    color: rgba(255, 255, 255, 0.8);
  }

  &.active {
    color: #409cff;
    font-weight: 500;
    border-bottom-color: #409cff;
  }
}
</style>
