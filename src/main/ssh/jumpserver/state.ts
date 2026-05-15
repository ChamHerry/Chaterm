import { type JumpServerConnectionData, type JumpServerMarkedCommand } from './constants'

export const jumpserverConnections = new Map<string, JumpServerConnectionData>()
export const jumpserverShellStreams = new Map<string, any>()
export const jumpserverExecStreams = new Map<string, any>()
const jumpserverExecStreamPromises = new Map<string, Promise<any>>()
const jumpserverExecQueueTails = new Map<string, Promise<void>>()
const jumpserverExecQueueDepths = new Map<string, number>()
export const jumpserverMarkedCommands = new Map<string, JumpServerMarkedCommand>()
export const jumpserverLastCommand = new Map<string, string>()
export const jumpserverInputBuffer = new Map<string, string>()
export const jumpserverConnectionStatus = new Map<string, { [key: string]: any }>()

export const getExecStreamPromise = (connectionId: string) => jumpserverExecStreamPromises.get(connectionId)
export const setExecStreamPromise = (connectionId: string, promise: Promise<any>) => jumpserverExecStreamPromises.set(connectionId, promise)
export const deleteExecStreamPromise = (connectionId: string) => jumpserverExecStreamPromises.delete(connectionId)

export const getExecQueueTail = (connectionId: string) => jumpserverExecQueueTails.get(connectionId)
export const setExecQueueTail = (connectionId: string, promise: Promise<void>) => jumpserverExecQueueTails.set(connectionId, promise)
export const deleteExecQueueTail = (connectionId: string) => jumpserverExecQueueTails.delete(connectionId)
export const incrementExecQueueDepth = (connectionId: string) => {
  const depth = (jumpserverExecQueueDepths.get(connectionId) || 0) + 1
  jumpserverExecQueueDepths.set(connectionId, depth)
  return depth
}
export const decrementExecQueueDepth = (connectionId: string) => {
  const depth = Math.max((jumpserverExecQueueDepths.get(connectionId) || 1) - 1, 0)
  if (depth === 0) {
    jumpserverExecQueueDepths.delete(connectionId)
  } else {
    jumpserverExecQueueDepths.set(connectionId, depth)
  }
  return depth
}
export const getExecQueueDepth = (connectionId: string) => jumpserverExecQueueDepths.get(connectionId) || 0
export const clearExecQueueState = (connectionId: string) => {
  jumpserverExecQueueTails.delete(connectionId)
  jumpserverExecQueueDepths.delete(connectionId)
}

export const jumpserverSessionPids = new Map<string, number>()
