export type Edition = 'cn' | 'global'

export interface EditionConfig {
  edition: Edition
  displayName: string
  auth: {
    yixinSsoBaseUrl: string
    yixinLoginPath: string
    yixinValidatePath: string
  }
  defaults: {
    language: string
  }
}

declare const __EDITION_CONFIG__: EditionConfig

export const getEditionConfig = (): EditionConfig => __EDITION_CONFIG__

export const APP_EDITION: Edition = __EDITION_CONFIG__.edition

export const isChineseEdition = (): boolean => APP_EDITION === 'cn'

export const isGlobalEdition = (): boolean => APP_EDITION === 'global'

export const getDefaultLanguage = (): string => import.meta.env.RENDERER_DEFAULT_LANGUAGE || __EDITION_CONFIG__.defaults.language

export const getYixinSsoBaseUrl = (): string => __EDITION_CONFIG__.auth.yixinSsoBaseUrl

export const getYixinLoginPath = (): string => __EDITION_CONFIG__.auth.yixinLoginPath

export const getYixinValidatePath = (): string => __EDITION_CONFIG__.auth.yixinValidatePath
