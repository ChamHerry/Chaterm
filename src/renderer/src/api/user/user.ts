const legacyApiRemoved = (name: string): Promise<any> => Promise.reject(new Error(`${name} was removed in YiXin-only local mode`))

export function sendEmailCode(_params?: unknown) {
  return legacyApiRemoved('sendEmailCode')
}

export function emailLogin(_params?: unknown) {
  return legacyApiRemoved('emailLogin')
}

export function sendMobileCode(_params?: unknown) {
  return legacyApiRemoved('sendMobileCode')
}

export function mobileLogin(_params?: unknown) {
  return legacyApiRemoved('mobileLogin')
}

export function userLogin(_params?: unknown) {
  return legacyApiRemoved('userLogin')
}

export function userLogOut() {
  return legacyApiRemoved('userLogOut')
}

export function getUser(_params?: unknown) {
  return legacyApiRemoved('getUser')
}

export function ssoToBearerToken(_params?: unknown) {
  return legacyApiRemoved('ssoToBearerToken')
}

export function getUserDevice(_data?: unknown) {
  return legacyApiRemoved('getUserDevice')
}

export function aliasUpdate(_data?: unknown) {
  return legacyApiRemoved('aliasUpdate')
}

export function aliasRefresh(_data?: unknown) {
  return legacyApiRemoved('aliasRefresh')
}

export function getTrustedDevices(_params?: unknown) {
  return legacyApiRemoved('getTrustedDevices')
}

export function revokeTrustedDevice(_data?: unknown) {
  return legacyApiRemoved('revokeTrustedDevice')
}

export function checkUserDevice(_data?: unknown) {
  return Promise.resolve({ code: 200, data: { isOfficeDevice: false } })
}

export function updateUser(_data?: unknown) {
  return legacyApiRemoved('updateUser')
}

export function updateAvatar(_data?: unknown) {
  return legacyApiRemoved('updateAvatar')
}

export function changePassword(_data?: unknown) {
  return legacyApiRemoved('changePassword')
}

export function sendEmailBindCode(_data?: unknown) {
  return legacyApiRemoved('sendEmailBindCode')
}

export function verifyAndBindEmail(_data?: unknown) {
  return legacyApiRemoved('verifyAndBindEmail')
}

export function sendMobileBindCode(_data?: unknown) {
  return legacyApiRemoved('sendMobileBindCode')
}

export function verifyAndBindMobile(_data?: unknown) {
  return legacyApiRemoved('verifyAndBindMobile')
}

export function deactivateAccount(_data?: unknown) {
  return legacyApiRemoved('deactivateAccount')
}
