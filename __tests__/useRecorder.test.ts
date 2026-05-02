/**
 * useRecorder state-machine tests
 *
 * Drives the hook through every state transition with a mocked
 * PluginHost: idle → arming → recording (×N loops) → stopping → idle,
 * plus the error and cancel paths. Verifies that the engine boundary
 * RPC is called at exactly the right moments (NOT on the arming-to-
 * recording transition; only on subsequent boundaries).
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

describe('useRecorder', () => {
  it('starts in the idle state with no error and zero chunks', () => {
    const { host } = createMockHost();
    const { result } = renderHook(() =>
      useRecorder(host, { onChunkFinalized: jest.fn() })
    );

    expect(result.current.state).toBe('idle');
    expect(result.current.error).toBeNull();
    expect(result.current.chunksFinalized).toBe(0);
  });

  it('transitions idle → arming → recording when start succeeds and a deck boundary fires', async () => {
    const { host, state } = createMockHost();
    const { result } = renderHook(() =>
      useRecorder(host, { onChunkFinalized: jest.fn() })
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

    // The very first boundary must NOT mark a chunk — chunk 0 is
    // already open from startTrackRecording. Marking would split off
    // an empty chunk and create a useless take-001.wav at start.
    expect(state.markBoundaryCallCount).toBe(0);
  });

  it('marks a boundary on each subsequent boundary while recording', async () => {
    const { host, state } = createMockHost();
    const { result } = renderHook(() =>
      useRecorder(host, { onChunkFinalized: jest.fn() })
    );

    await act(async () => {
      await result.current.start('mic-1');
    });
    act(() => {
      fireBoundary(state, 0);
    });

    // Three more boundaries → 3 markBoundary calls (chunks 1, 2, 3).
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

  it('forwards each chunk-finalized event to the caller and increments chunksFinalized', async () => {
    const { host, state } = createMockHost();
    const onChunk = jest.fn();
    const { result } = renderHook(() => useRecorder(host, { onChunkFinalized: onChunk }));

    await act(async () => {
      await result.current.start('mic-1');
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

    expect(onChunk).toHaveBeenCalledTimes(3);
    expect(onChunk.mock.calls[0][0].chunkIndex).toBe(0);
    expect(onChunk.mock.calls[2][0].chunkIndex).toBe(2);
    expect(result.current.chunksFinalized).toBe(3);
  });

  it('transitions to error state when startTrackRecording rejects', async () => {
    const { host, state } = createMockHost();
    state.startResolves = false;
    state.startError = 'Permission denied';

    const { result } = renderHook(() =>
      useRecorder(host, { onChunkFinalized: jest.fn() })
    );

    await act(async () => {
      await result.current.start('mic-1');
    });

    expect(result.current.state).toBe('error');
    expect(result.current.error).toBe('Permission denied');
  });

  it('stop transitions stopping → idle and calls stopTrackRecording', async () => {
    const { host, state } = createMockHost();
    const { result } = renderHook(() =>
      useRecorder(host, { onChunkFinalized: jest.fn() })
    );

    await act(async () => {
      await result.current.start('mic-1');
    });
    act(() => {
      fireBoundary(state, 0);
    });
    expect(result.current.state).toBe('recording');

    await act(async () => {
      await result.current.stop();
    });

    expect(state.stopCallCount).toBe(1);
    await waitFor(() => {
      expect(result.current.state).toBe('idle');
    });
  });

  it('cancel cleans up without surfacing an error even when stop throws', async () => {
    const { host, state } = createMockHost();
    (host.stopTrackRecording as jest.Mock).mockRejectedValueOnce(new Error('engine offline'));

    const { result } = renderHook(() =>
      useRecorder(host, { onChunkFinalized: jest.fn() })
    );

    await act(async () => {
      await result.current.start('mic-1');
    });
    act(() => {
      fireBoundary(state, 0);
    });

    await act(async () => {
      await result.current.cancel();
    });

    expect(result.current.state).toBe('idle');
    expect(result.current.error).toBeNull();
  });

  it('start during stopping/recording is a no-op (does not call startTrackRecording twice)', async () => {
    const { host, state } = createMockHost();
    const { result } = renderHook(() =>
      useRecorder(host, { onChunkFinalized: jest.fn() })
    );

    await act(async () => {
      await result.current.start('mic-1');
    });
    expect(state.startCallCount).toBe(1);

    // Second start while in arming state — should be ignored.
    await act(async () => {
      await result.current.start('mic-1');
    });
    expect(state.startCallCount).toBe(1);
  });
});
