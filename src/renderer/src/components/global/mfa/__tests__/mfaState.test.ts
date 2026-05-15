import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  currentOtpId,
  handleOtpError,
  handleOtpRequest,
  isSubmitting,
  otpCode,
  resetOtpDialog,
  showOtpDialog,
  showOtpDialogErr,
  submitOtpCode
} from '../mfaState'

vi.mock('@/utils/logger', () => ({
  createRendererLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

describe('mfaState', () => {
  afterEach(() => {
    resetOtpDialog()
    vi.useRealTimers()
    vi.clearAllMocks()
    delete (window as any).api
  })

  it('keeps the dialog open after submitting an OTP until a result arrives', async () => {
    vi.useFakeTimers()
    ;(window as any).api = {
      submitKeyboardInteractiveResponse: vi.fn().mockResolvedValue(undefined)
    }
    handleOtpRequest({ id: 'otp-1', prompts: ['Code:'] })
    otpCode.value = '123456'

    await submitOtpCode()

    expect((window as any).api.submitKeyboardInteractiveResponse).toHaveBeenCalledWith('otp-1', '123456')
    expect(showOtpDialog.value).toBe(true)
    expect(currentOtpId.value).toBe('otp-1')
    expect(isSubmitting.value).toBe(true)
  })

  it('keeps the same dialog visible for a non-final failed result', () => {
    vi.useFakeTimers()
    handleOtpRequest({ id: 'otp-2', prompts: ['Code:'] })
    otpCode.value = 'bad-code'
    isSubmitting.value = true

    handleOtpError({ id: 'otp-2', status: 'failed', attempts: 1 })

    expect(showOtpDialog.value).toBe(true)
    expect(currentOtpId.value).toBe('otp-2')
    expect(showOtpDialogErr.value).toBe(true)
    expect(otpCode.value).toBe('')
    expect(isSubmitting.value).toBe(false)
  })

  it('resets the dialog for success and final failure results', () => {
    vi.useFakeTimers()
    handleOtpRequest({ id: 'otp-3', prompts: ['Code:'] })
    handleOtpError({ id: 'otp-3', status: 'failed', final: true })

    expect(showOtpDialog.value).toBe(false)
    expect(currentOtpId.value).toBeNull()

    handleOtpRequest({ id: 'otp-4', prompts: ['Code:'] })
    handleOtpError({ id: 'otp-4', status: 'success' })

    expect(showOtpDialog.value).toBe(false)
    expect(currentOtpId.value).toBeNull()
  })
})
