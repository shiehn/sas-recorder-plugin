/**
 * useRecorder — loop-aware recording state machine for the recorder plugin.
 *
 * State transitions:
 *
 *   idle ──Record──► arming ──onDeckBoundary──► recording (loop 0)
 *                       │
 *                       ├──onDeckBoundary──► markRecordingChunkBoundary
 *                       │                     ↓ engine emits chunkFinalized
 *                       │                     hook BUFFERS the chunk
 *                       │                     ↓
 *                       │                  recording (loop N+1)
 *                       │
 *                       └──Stop──► stopping ──stopTrackRecording──►
 *                                  final chunk added to buffer
 *                                  → onSessionFinalized(chunks[]) fires once
 *                                  → idle
 *
 * Key design (Phase 8.1): the hook does NOT touch tracks per-chunk during
 * recording. It buffers `RecordingChunkFinalizedEvent` payloads in memory
 * and emits a single `onSessionFinalized(chunks)` callback on stop. The
 * caller (RecorderPanel) processes the full list in a tight batch — this
 * keeps the audio thread free from Tracktion track-creation pressure
 * during the live capture window.
 *
 * The 1:1 mapping (one chunk → one Tracktion track) is preserved; only
 * the *timing* of track creation moves to stop.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  PluginHost,
  RecordingChunkFinalizedEvent,
} from '@signalsandsorcery/plugin-sdk';

export type RecorderState = 'idle' | 'arming' | 'recording' | 'stopping' | 'error';

export interface UseRecorderResult {
  state: RecorderState;
  /** Last error message, when state==='error'. Cleared when leaving error. */
  error: string | null;
  /** Number of chunks captured so far in the current session. */
  chunksFinalized: number;
  /**
   * Begin a session. Arms first; engine waits for the next deck boundary.
   *
   * Note: `deviceId` becomes optional once the SDK widens
   * `host.startTrackRecording` to accept undefined (Phase 8.4); until
   * then the caller must supply the platform-resolved input device id.
   */
  start: (deviceId: string) => Promise<void>;
  /** End the current session. All chunks are delivered via onSessionFinalized. */
  stop: () => Promise<void>;
  /**
   * Cancel the current arming/recording state without finalizing the
   * pending session. No `onSessionFinalized` fires; buffered chunks are
   * dropped. Used when scenes change mid-session.
   */
  cancel: () => Promise<void>;
}

export interface UseRecorderOptions {
  /**
   * Called once when a session ends cleanly via `stop()` with the full
   * ordered list of finalized chunks (boundary chunks + the final chunk
   * from the stop call). The caller is responsible for batch-creating
   * Tracktion tracks from these chunks.
   */
  onSessionFinalized: (chunks: RecordingChunkFinalizedEvent[]) => void | Promise<void>;
}

/**
 * Drives the recorder state machine against a PluginHost. Subscribes to
 * `host.onDeckBoundary` while recording so each loop boundary issues
 * `host.markRecordingChunkBoundary`. Buffers `chunkFinalized` events in
 * memory; flushes them via `onSessionFinalized` on stop.
 */
export function useRecorder(
  host: PluginHost,
  { onSessionFinalized }: UseRecorderOptions
): UseRecorderResult {
  const [state, setState] = useState<RecorderState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [chunksFinalized, setChunksFinalized] = useState(0);

  // Refs needed to bridge between the engine event callback (which lives
  // outside React's render cycle) and current React state.
  const stateRef = useRef<RecorderState>('idle');
  stateRef.current = state;

  const onSessionFinalizedRef = useRef(onSessionFinalized);
  onSessionFinalizedRef.current = onSessionFinalized;

  // Buffered chunks for the active session. Reset on start; flushed on
  // stop. Held in a ref so the engine event callback can append to it
  // without triggering re-renders for every chunk.
  const chunksBufferRef = useRef<RecordingChunkFinalizedEvent[]>([]);

  // Keep boundary listener subscribed only while we're actively recording.
  const boundaryUnsubRef = useRef<(() => void) | null>(null);

  // Chunk-finalized listener subscribed for the lifetime of the hook.
  // Plugin host auto-cleans these on plugin deactivation.
  useEffect(() => {
    const unsub = host.onRecordingChunkFinalized((event) => {
      // Accept events only while a session is active. A late event from
      // a previous session (e.g. cancel-then-quick-restart) gets dropped.
      const s = stateRef.current;
      if (s === 'idle' || s === 'error') return;
      chunksBufferRef.current.push(event);
      setChunksFinalized(chunksBufferRef.current.length);
    });
    return unsub;
  }, [host]);

  const subscribeBoundaryListener = useCallback(() => {
    if (boundaryUnsubRef.current) return;  // Already subscribed.
    boundaryUnsubRef.current = host.onDeckBoundary(() => {
      if (stateRef.current === 'recording') {
        host.markRecordingChunkBoundary().catch((err) => {
          console.error('[useRecorder] markRecordingChunkBoundary failed:', err);
        });
      } else if (stateRef.current === 'arming') {
        // First boundary after arming → flip to recording. The engine's
        // chunk 0 already started at the call to startTrackRecording;
        // calling markBoundary here would split off an empty chunk 0
        // and start chunk 1, so we just transition state.
        setState('recording');
      }
    });
  }, [host]);

  const unsubscribeBoundaryListener = useCallback(() => {
    if (boundaryUnsubRef.current) {
      boundaryUnsubRef.current();
      boundaryUnsubRef.current = null;
    }
  }, []);

  const start = useCallback(
    async (deviceId: string): Promise<void> => {
      if (stateRef.current !== 'idle' && stateRef.current !== 'error') {
        return;
      }
      setError(null);
      setChunksFinalized(0);
      chunksBufferRef.current = [];
      setState('arming');
      try {
        await host.startTrackRecording(deviceId);
        subscribeBoundaryListener();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        setState('error');
        unsubscribeBoundaryListener();
      }
    },
    [host, subscribeBoundaryListener, unsubscribeBoundaryListener]
  );

  const stop = useCallback(async (): Promise<void> => {
    if (stateRef.current !== 'recording' && stateRef.current !== 'arming') {
      return;
    }
    setState('stopping');
    unsubscribeBoundaryListener();
    try {
      await host.stopTrackRecording();

      // The final chunk arrives via the host's event channel. The engine
      // emits the broadcast on the IPC thread synchronously from the
      // stopRecording RPC handler (see IPCServer.cpp), but the renderer
      // sees it as an async event — wait briefly so the buffer captures
      // it before we flush.
      await new Promise<void>((resolve) => setTimeout(resolve, 50));

      // Snapshot + flush. Reset buffer BEFORE invoking the callback so
      // any errors in the caller don't leak into the next session.
      const snapshot = chunksBufferRef.current.slice();
      chunksBufferRef.current = [];

      try {
        await onSessionFinalizedRef.current(snapshot);
      } catch (cbErr) {
        console.error('[useRecorder] onSessionFinalized handler threw:', cbErr);
      }

      setState('idle');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setState('error');
    }
  }, [host, unsubscribeBoundaryListener]);

  const cancel = useCallback(async (): Promise<void> => {
    if (stateRef.current === 'idle' || stateRef.current === 'error') {
      return;
    }
    unsubscribeBoundaryListener();
    try {
      await host.stopTrackRecording();
    } catch {
      // Best-effort cleanup; ignore errors on cancel.
    }
    // Drop buffered chunks — cancel intentionally does NOT fire
    // onSessionFinalized.
    chunksBufferRef.current = [];
    setChunksFinalized(0);
    setState('idle');
    setError(null);
  }, [host, unsubscribeBoundaryListener]);

  // Cleanup on unmount: stop any active session and drop subscriptions.
  useEffect(() => {
    return () => {
      unsubscribeBoundaryListener();
      if (stateRef.current === 'recording' || stateRef.current === 'arming') {
        host.stopTrackRecording().catch(() => {
          /* best-effort */
        });
      }
    };
  }, [host, unsubscribeBoundaryListener]);

  return { state, error, chunksFinalized, start, stop, cancel };
}
