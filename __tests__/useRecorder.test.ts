/**
 * useRecorder state-machine tests (Phase 8.1 — batch model)
 *
 * Drives the hook through every state transition with a mocked
 * PluginHost: idle → arming → recording (×N loops) → stopping → idle,
 * plus the error and cancel paths.
 *
 * Key Phase 8.1 invariants verified:
 *   1. The engine boundary RPC (`markRecordingChunkBoundary`) is called
 *      on every loop boundary AFTER the arming → recording transition,
 *      but NOT on the very first boundary (chunk 0 was opened at start).
 *   2. `onSessionFinalized` fires EXACTLY ONCE per stop, with the full
 *      ordered chunk list. No per-chunk callback fires during recording.
 *   3. `cancel` does NOT fire `onSessionFinalized` — buffered chunks
 *      are dropped on cancel.
 */

import { renderHook, act, waitFor } from '@testing-library/react';
import type {
  PluginHost,
  RecordingChunkFinalizedEvent,
  DeckBoundaryEvent,
} from '@signalsandsorcery/plugin-sdk';
import { useRecorder } from '../src/useRecorder';

interface MockHostState {
  startCallCount: number;
  startResolves: boolean;
  startError: string | null;
  stopCallCount: number;
  markBoundaryCallCount: number;
  boundaryListeners: Array<(event: DeckBoundaryEvent) => void>;
  chunkListeners: Array<(event: RecordingChunkFinalizedEvent) => void>;
}

function createMockHost(): { host: PluginHost; state: MockHostState } {
  const state: MockHostState = {
    startCallCount: 0,
    startResolves: true,
    startError: null,
    stopCallCount: 0,
    markBoundaryCallCount: 0,
    boundaryListeners: [],
    chunkListeners: [],
  };

  const host = {
    startTrackRecording: jest.fn(async (_deviceId: string) => {
      state.startCallCount++;
      if (!state.startResolves) {
        throw new Error(state.startError ?? 'mock start error');
      }
    }),
    stopTrackRecording: jest.fn(async () => {
      state.stopCallCount++;
      return { finalChunkPath: '/tmp/take-final.wav', durationMs: 1000 };
    }),
    markRecordingChunkBoundary: jest.fn(async () => {
      state.markBoundaryCallCount++;
    }),
    onDeckBoundary: jest.fn((listener: (event: DeckBoundaryEvent) => void) => {
      state.boundaryListeners.push(listener);
      return () => {
        state.boundaryListeners = state.boundaryListeners.filter((l) => l !== listener);
      };
    }),
    onRecordingChunkFinalized: jest.fn(
      (listener: (event: RecordingChunkFinalizedEvent) => void) => {
        state.chunkListeners.push(listener);
        return () => {
          state.chunkListeners = state.chunkListeners.filter((l) => l !== listener);
        };
      }
    ),
  } as unknown as PluginHost;

  return { host, state };
}

function fireBoundary(state: MockHostState, loopCount: number): void {
  const event: DeckBoundaryEvent = { deckId: 'loop-a', bar: 0, beat: 0, loopCount };
  for (const listener of state.boundaryListeners) {
    listener(event);
  }
}

function fireChunkFinalized(state: MockHostState, chunkIndex: number): void {
  const event: RecordingChunkFinalizedEvent = {
    filePath: `/tmp/take-${chunkIndex}.wav`,
    chunkIndex,
    durationMs: 100,
    sampleRate: 48000,
    channels: 1,
  };
  for (const listener of state.chunkListeners) {
    listener(event);
  }
}

describe('useRecorder (Phase 8.1 batch model)', () => {
  it('starts in the idle state with no error and zero chunks', () => {
    const { host } = createMockHost();
    const { result } = renderHook(() =>
      useRecorder(host, { onSessionFinalized: jest.fn() })
    );

    expect(result.current.state).toBe('idle');
    expect(result.current.error).toBeNull();
    expect(result.current.chunksFinalized).toBe(0);
  });

  it('transitions idle → arming → recording when start succeeds and a deck boundary fires', async () => {
    const { host, state } = createMockHost();
    const { result } = renderHook(() =>
      useRecorder(host, { onSessionFinalized: jest.fn() })
    );

    await act(async () => {
      await result.current.start('mic-1');
    });

    expect(state.startCallCount).toBe(1);
    expect(result.current.state).toBe('arming');

    act(() => {
      fireBoundary(state, 0);
    });
    expect(result.current.state).toBe('recording');
    // First boundary must NOT mark a chunk — chunk 0 already open.
    expect(state.markBoundaryCallCount).toBe(0);
  });

  it('marks a boundary on each subsequent boundary while recording', async () => {
    const { host, state } = createMockHost();
    const { result } = renderHook(() =>
      useRecorder(host, { onSessionFinalized: jest.fn() })
    );

    await act(async () => {
      await result.current.start('mic-1');
    });
    act(() => {
      fireBoundary(state, 0);
    });

    act(() => {
      fireBoundary(state, 1);
    });
    act(() => {
      fireBoundary(state, 2);
    });
    act(() => {
      fireBoundary(state, 3);
    });

    expect(state.markBoundaryCallCount).toBe(3);
  });

  it('buffers chunks during recording — onSessionFinalized does NOT fire per chunk', async () => {
    const { host, state } = createMockHost();
    const onSession = jest.fn();
    const { result } = renderHook(() => useRecorder(host, { onSessionFinalized: onSession }));

    await act(async () => {
      await result.current.start('mic-1');
    });
    act(() => {
      fireBoundary(state, 0);
    });

    // Three chunks finalize while recording — none of these should
    // trigger onSessionFinalized.
    act(() => {
      fireChunkFinalized(state, 0);
    });
    act(() => {
      fireChunkFinalized(state, 1);
    });
    act(() => {
      fireChunkFinalized(state, 2);
    });

    expect(onSession).not.toHaveBeenCalled();
    // chunksFinalized counter still updates so the panel can show progress.
    expect(result.current.chunksFinalized).toBe(3);
  });

  it('flushes the entire chunk buffer to onSessionFinalized exactly once on stop', async () => {
    const { host, state } = createMockHost();
    const onSession = jest.fn();
    const { result } = renderHook(() => useRecorder(host, { onSessionFinalized: onSession }));

    await act(async () => {
      await result.current.start('mic-1');
    });
    act(() => {
      fireBoundary(state, 0);
    });

    act(() => {
      fireChunkFinalized(state, 0);
    });
    act(() => {
      fireChunkFinalized(state, 1);
    });
    act(() => {
      fireChunkFinalized(state, 2);
    });

    // Stop. The hook waits ~50ms for the final chunk to land via the
    // engine event channel; simulate that arriving during the wait.
    await act(async () => {
      const stopPromise = result.current.stop();
      // Final chunk fires while stop() is awaiting the dispatch window.
      fireChunkFinalized(state, 3);
      await stopPromise;
    });

    expect(onSession).toHaveBeenCalledTimes(1);
    const flushedChunks = onSession.mock.calls[0][0] as RecordingChunkFinalizedEvent[];
    expect(flushedChunks).toHaveLength(4);
    expect(flushedChunks.map((c) => c.chunkIndex)).toEqual([0, 1, 2, 3]);

    await waitFor(() => {
      expect(result.current.state).toBe('idle');
    });
  });

  it('transitions to error state when startTrackRecording rejects', async () => {
    const { host, state } = createMockHost();
    state.startResolves = false;
    state.startError = 'Permission denied';

    const { result } = renderHook(() =>
      useRecorder(host, { onSessionFinalized: jest.fn() })
    );

    await act(async () => {
      await result.current.start('mic-1');
    });

    expect(result.current.state).toBe('error');
    expect(result.current.error).toBe('Permission denied');
  });

  it('cancel drops buffered chunks and does NOT fire onSessionFinalized', async () => {
    const { host, state } = createMockHost();
    const onSession = jest.fn();
    const { result } = renderHook(() => useRecorder(host, { onSessionFinalized: onSession }));

    await act(async () => {
      await result.current.start('mic-1');
    });
    act(() => {
      fireBoundary(state, 0);
    });
    act(() => {
      fireChunkFinalized(state, 0);
    });
    act(() => {
      fireChunkFinalized(state, 1);
    });

    await act(async () => {
      await result.current.cancel();
    });

    expect(onSession).not.toHaveBeenCalled();
    expect(result.current.state).toBe('idle');
    expect(result.current.error).toBeNull();
    expect(result.current.chunksFinalized).toBe(0);
  });

  it('start during arming/recording is a no-op (does not call startTrackRecording twice)', async () => {
    const { host, state } = createMockHost();
    const { result } = renderHook(() =>
      useRecorder(host, { onSessionFinalized: jest.fn() })
    );

    await act(async () => {
      await result.current.start('mic-1');
    });
    expect(state.startCallCount).toBe(1);

    // Second start while still in arming state — should be ignored.
    await act(async () => {
      await result.current.start('mic-1');
    });
    expect(state.startCallCount).toBe(1);
  });

  it('chunk events arriving after a session ends are ignored (no leak into next session)', async () => {
    const { host, state } = createMockHost();
    const onSession = jest.fn();
    const { result } = renderHook(() => useRecorder(host, { onSessionFinalized: onSession }));

    // Session 1: start, capture, stop.
    await act(async () => {
      await result.current.start('mic-1');
    });
    act(() => {
      fireBoundary(state, 0);
    });
    act(() => {
      fireChunkFinalized(state, 0);
    });
    await act(async () => {
      await result.current.stop();
    });

    // Late chunk event (shouldn't happen in practice, but defensive).
    onSession.mockClear();
    act(() => {
      fireChunkFinalized(state, 99);
    });

    // Late event should NOT trigger another callback or affect the next session.
    expect(onSession).not.toHaveBeenCalled();

    // Session 2: start fresh — chunksFinalized starts at 0.
    await act(async () => {
      await result.current.start('mic-1');
    });
    expect(result.current.chunksFinalized).toBe(0);
  });
});
