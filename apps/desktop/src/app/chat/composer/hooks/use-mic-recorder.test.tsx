import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useMicRecorder, type MicRecorderErrorCopy } from './use-mic-recorder'

// t_421c7a87: the browser's noiseSuppression gate-chops speech (fragments,
// shifted speech onset reaching the STT recognizer), so the recorder must
// request the microphone with noiseSuppression OFF while keeping echo
// cancellation and enabling auto gain control.

const copy: MicRecorderErrorCopy = {
  microphoneAccessDenied: 'access denied',
  microphoneConstraintsUnsupported: 'constraints unsupported',
  microphoneInUse: 'in use',
  microphonePermissionDenied: 'permission denied',
  microphoneStartFailed: 'start failed',
  microphoneUnsupported: 'unsupported',
  noMicrophone: 'no microphone'
}

function fakeStream(): MediaStream {
  return { getTracks: () => [{ stop: () => {} }] } as unknown as MediaStream
}

class FakeMediaRecorder {
  static isTypeSupported = vi.fn(() => true)
  state = 'inactive'
  ondataavailable: ((event: unknown) => void) | null = null
  onstop: (() => void) | null = null

  constructor(
    public stream: MediaStream,
    public options?: MediaRecorderOptions
  ) {}

  start() {
    this.state = 'recording'
  }

  stop() {
    this.state = 'inactive'
  }
}

describe('useMicRecorder getUserMedia constraints', () => {
  let savedMediaDevices: PropertyDescriptor | undefined

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    if (savedMediaDevices) {
      Object.defineProperty(navigator, 'mediaDevices', savedMediaDevices)
      savedMediaDevices = undefined
    }
  })

  it('keeps noiseSuppression off and echoCancellation + autoGainControl on (t_421c7a87)', async () => {
    const getUserMedia = vi.fn(
      async (_constraints: MediaStreamConstraints) => fakeStream()
    )
    savedMediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices')
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia }
    })
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
    ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = {
      requestMicrophoneAccess: async () => true
    }

    const { result } = renderHook(() => useMicRecorder(copy))

    await act(async () => {
      await result.current.handle.start()
    })

    expect(getUserMedia).toHaveBeenCalledTimes(1)
    const constraints = getUserMedia.mock.calls[0][0] as {
      audio: Record<string, boolean>
    }
    expect(constraints.audio).toEqual({
      echoCancellation: true,
      noiseSuppression: false,
      autoGainControl: true
    })
  })
})
