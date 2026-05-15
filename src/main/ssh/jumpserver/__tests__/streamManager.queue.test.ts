import { EventEmitter } from 'events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JUMPSERVER_CONSTANTS } from '../constants'
import { clearExecQueueState, jumpserverExecStreams } from '../state'
import { executeCommandOnJumpServerExecQueued } from '../streamManager'

class FakeExecStream extends EventEmitter {
  public writes: string[] = []
  public stderr = new EventEmitter()

  write(data: string) {
    this.writes.push(data)
    return true
  }

  end() {
    this.emit('close')
  }
}

const flushMicrotasks = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

const extractMarkers = (write: string) => {
  const marker = write.match(/echo "(__CHATERM_EXEC_END_[^"]+)"/)?.[1]
  const exitCodeMarker = write.match(/echo "(__CHATERM_EXIT_CODE_[^$]+)\$\?"/)?.[1]
  if (!marker || !exitCodeMarker) {
    throw new Error(`Unable to extract markers from write: ${write}`)
  }
  return { marker, exitCodeMarker }
}

const completeLatestCommand = async (stream: FakeExecStream, stdout: string, exitCode = 0) => {
  const latestWrite = stream.writes[stream.writes.length - 1]
  const { marker, exitCodeMarker } = extractMarkers(latestWrite)
  await vi.advanceTimersByTimeAsync(JUMPSERVER_CONSTANTS.DATA_COLLECTION_DELAY)
  stream.emit('data', Buffer.from(`\r\n${stdout}\r\n${marker}\r\n${exitCodeMarker}${exitCode}\r\n`))
  await vi.advanceTimersByTimeAsync(JUMPSERVER_CONSTANTS.DATA_SETTLE_DELAY)
  await flushMicrotasks()
}

describe('JumpServer exec command queue', () => {
  afterEach(() => {
    vi.useRealTimers()
    jumpserverExecStreams.clear()
    clearExecQueueState('queue-session')
  })

  it('runs concurrent commands sequentially on the shared exec stream', async () => {
    vi.useFakeTimers()
    const stream = new FakeExecStream()
    jumpserverExecStreams.set('queue-session', stream)

    const first = executeCommandOnJumpServerExecQueued('queue-session', 'echo first', { kind: 'user-command' })
    const second = executeCommandOnJumpServerExecQueued('queue-session', 'echo second', { kind: 'system-info' })
    const third = executeCommandOnJumpServerExecQueued('queue-session', 'echo third', { kind: 'pid-probe' })

    await flushMicrotasks()
    expect(stream.writes).toHaveLength(1)
    expect(stream.writes[0]).toContain('echo first')

    await completeLatestCommand(stream, 'first')
    await expect(first).resolves.toMatchObject({ success: true, stdout: 'first' })
    await flushMicrotasks()
    expect(stream.writes).toHaveLength(2)
    expect(stream.writes[1]).toContain('echo second')

    await completeLatestCommand(stream, 'second')
    await expect(second).resolves.toMatchObject({ success: true, stdout: 'second' })
    await flushMicrotasks()
    expect(stream.writes).toHaveLength(3)
    expect(stream.writes[2]).toContain('echo third')

    await completeLatestCommand(stream, 'third')
    await expect(third).resolves.toMatchObject({ success: true, stdout: 'third' })
  })

  it('continues with the next queued command after a timeout', async () => {
    vi.useFakeTimers()
    const stream = new FakeExecStream()
    jumpserverExecStreams.set('queue-session', stream)

    const first = executeCommandOnJumpServerExecQueued('queue-session', 'sleep 60', { kind: 'user-command' })
    const second = executeCommandOnJumpServerExecQueued('queue-session', 'echo recovered', { kind: 'user-command' })

    await flushMicrotasks()
    expect(stream.writes).toHaveLength(1)
    expect(stream.writes[0]).toContain('sleep 60')

    await vi.advanceTimersByTimeAsync(JUMPSERVER_CONSTANTS.COMMAND_EXEC_TIMEOUT)
    await expect(first).resolves.toMatchObject({ success: false, error: 'Command execution timeout' })
    await flushMicrotasks()

    expect(stream.writes).toHaveLength(2)
    expect(stream.writes[1]).toContain('echo recovered')

    await completeLatestCommand(stream, 'recovered')
    await expect(second).resolves.toMatchObject({ success: true, stdout: 'recovered' })
  })
})
