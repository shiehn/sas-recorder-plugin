/**
 * useRecorder — loop-aware recording state machine for the recorder plugin.
 *
 * State transitions (see /Users/stevehiehn/.claude/plans/i-need-a-new-dreamy-phoenix.md
 * for the canonical diagram):
 *
 *   idle ──Record──► arming ──onDeckBoundary──► recording (loop 0)
 *                       │
 *                       ├──onDeckBoundary──► markRecordingChunkBoundary
 *                       │                     ↓ engine emits chunkFinalized
 *                       │                     onChunkFinalized → caller creates+populates+mutes track
 *                       │                     ↓
 *                       │                  recording (loop N+1)
 *                       │
 *                       └──Stop──► stopping ──stopTrackRecording──►
 *                                  onChunkFinalized (final) → caller creates final track
 *                                  → idle
 *
 * The hook calls host methods but does NOT touch tracks itself — it
 * surfaces `onChunkFinalized` so the caller (RecorderPanel) decides what
 * to do with each finalized WAV (create track, mute, name, FX preset, etc).
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
  /** Number of chunks finalized since the current session started. */
  chunksFinalized: number;
  /** Begin a session. Arms first; engine waits for the next deck boundary. */
  start: (deviceId: string) => Promise<void>;
  /** End the current session. Final chunk is finalized via stopRecording. */
  stop: () => Promise<void>;
  /**
   * Cancel the current arming/recording state without finalizing the
   * pending take. Used when scenes change mid-session.
   */
  cancel: () => Promise<void>;
}

export interface UseRecorderOptions {
  /** Called when each chunk is finalized (per loop boundary + once on stop). */
  onChunkFinalized: (event: RecordingChunkFinalizedEvent) => void;
}

/**
 * Drives the recorder state machine against a PluginHost. Subscribes to
 * `host.onDeckBoundary` while recording so each loop boundary issues
 * `host.markRecordingChunkBoundary`.
 */
export function useRecorder(
  host: PluginHost,
  { onChunkFinalized }: UseRecorderOptions
): UseRecorderResult {
  const [state, setState] = useState<RecorderState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [chunksFinalized, setChunksFinalized] = useState(0);

  // Refs needed to bridge between the engine event callback (which lives
  // outside React's render cycle) and current React state.
  const stateRef = useRef<RecorderState>('idle');
  stateRef.current = state;

  const onChunkFinalizedRef = useRef(onChunkFinalized);
  onChunkFinalizedRef.current = onChunkFinalized;

  // Keep boundary listener subscribed only while we're actively recording.
  const boundaryUnsubRef = useRef<(() => void) | null>(null);

  // Chunk-finalized listener subscribed for the lifetime of the hook.
  // Plugin host auto-cleans these on plugin deactivation.
  useEffect(() => {
    const unsub = host.onRecordingChunkFinalized((event) => {
      setChunksFinalized((n) => n + 1);
      try {
        onChunkFinalizedRef.current(event);
      } catch (err) {
        console.error('[useRecorder] onChunkFinalized handler threw:', err);
      }
    });
    return unsub;
  }, [host]);

  const subscribeBoundaryListener = useCallback(() => {
    if (boundaryUnsubRef.current) return;  // Already subscribed.
    boundaryUnsubRef.current = host.onDeckBoundary(() => {
      // Fire boundary marker only while actively recording. The arming
      // state's boundary is the trigger for transitioning to recording —
      // the engine's first chunk auto-opens at start so we don't need to
      // mark anything on the very first boundary.
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
      // Final chunk fires onChunkFinalized via the host's event channel.
      // Wait one microtask for that to dispatch before flipping to idle.
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
