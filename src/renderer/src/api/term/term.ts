import type { CommonResponse, TermPostData, TermQueryParams } from './define'

const removed = (): Promise<CommonResponse> => Promise.reject(new Error('Legacy remote terminal API was removed in YiXin-only local mode'))

export function termFileContent(_parameter: TermQueryParams): Promise<CommonResponse> {
  return removed()
}

export function termFileContentSave(_data: TermPostData): Promise<CommonResponse> {
  return removed()
}

export function termFileLs(_parameter: TermQueryParams): Promise<CommonResponse> {
  return removed()
}

export function getUserSessionList(_data: TermPostData): Promise<CommonResponse> {
  return removed()
}
