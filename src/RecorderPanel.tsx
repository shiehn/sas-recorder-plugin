/**
 * RecorderPanel — top-level UI for the Recorder plugin.
 *
 * Phase 8 surface:
 *   - Input device + latency live on the platform (Audio Routing panel).
 *     This panel just shows a hint when no input is configured.
 *   - Per-chunk track creation moved to STOP — the panel buffers
 *     RecordingChunkFinalizedEvents during recording (via useRecorder)
 *     and batch-creates Tracktion tracks once the user clicks Stop.
 *     Avoids audio-thread pressure during the live capture window.
 *   - 1:1 mapping preserved: each chunk → one audio track in the scene.
 *     Users delete takes manually via the ✕ on each row.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type {
  PluginUIProps,
  AudioInputDevice,
  RecordingTargetInfo,
  RecordingChunkFinalizedEvent,
  PluginTrackHandle,
} from '@signalsandsorcery/plugin-sdk';
import { useRecorder } from './useRecorder';
import { WaveformView } from './shared/WaveformView';
import {
  VOCAL_PRESETS,
  applyVocalPreset,
  applyVocalPresetToTracks,
  type VocalPresetId,
} from './vocalPresets';

interface Take {
  /** Tracktion engine track id (PluginTrackHandle.id). */
  trackId: string;
  /** Database row id (PluginTrackHandle.dbId). */
  dbId: string;
  /** Take label rendered on the row. */
  label: string;
  /** Path to the finalized WAV. */
  filePath: string;
  /** Engine chunk index this take corresponds to. */
  chunkIndex: number;
}

/** Take counter — engineers expect take numbers to start at 1, not 0. */
function buildTakeLabel(takeNumber: number, chunkIndex: number): string {
  return `Take ${takeNumber} · chunk ${chunkIndex + 1}`;
}

export const RecorderPanel: React.FC<PluginUIProps> = ({
  host,
  activeSceneId,
  isAuthenticated,
  isConnected,
}) => {
  const [targetInfo, setTargetInfo] = useState<RecordingTargetInfo | null>(null);
  const [platformInput, setPlatformInput] = useState<AudioInputDevice | null>(null);
  const [takes, setTakes] = useState<Take[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [vocalPresetId, setVocalPresetId] = useState<VocalPresetId>('none');
  const vocalPresetIdRef = useRef<VocalPresetId>('none');
  vocalPresetIdRef.current = vocalPresetId;

  // Refresh target info when scene changes; gates Record button.
  useEffect(() => {
    let cancelled = false;
    host
      .getRecordingTargetInfo()
      .then((info) => {
        if (!cancelled) setTargetInfo(info);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [host, activeSceneId]);

  // Read the platform-configured input device on mount + whenever the
  // panel re-mounts. (The Audio Routing panel is where users actually
  // change this; we just display it here.)
  useEffect(() => {
    let cancelled = false;
    host
      .getCurrentInputDevice()
      .then((device) => {
        if (!cancelled) setPlatformInput(device);
      })
      .catch(() => {
        // Fall through with null — UI shows "configure input" hint.
      });
    return () => {
      cancelled = true;
    };
  }, [host]);

  /**
   * Batch-create Tracktion tracks from the chunks captured during the
   * recording session. Called once when `useRecorder.stop()` resolves —
   * NOT per-chunk. This keeps Tracktion mutation off the audio thread
   * during the live capture window; instead, all N tracks appear in one
   * tight loop after the user clicks Stop.
   */
  const handleSessionFinalized = useCallback(
    async (chunks: RecordingChunkFinalizedEvent[]): Promise<void> => {
      if (chunks.length === 0) return;

      // Read the platform's calibrated latency offset ONCE at the start
      // of the batch — applied to every new track so they line up with
      // the source loop.
      let offset = 0;
      try {
        offset = await host.getRecordingLatencyOffsetSamples();
      } catch (err) {
        console.warn('[RecorderPanel] getRecordingLatencyOffsetSamples failed:', err);
      }

      const presetId = vocalPresetIdRef.current;
      const preset = VOCAL_PRESETS.find((p) => p.id === presetId);

      const baseTakeNumber = takes.length;
      const newTakes: Take[] = [];

      for (let i = 0; i < chunks.length; i++) {
        const event = chunks[i];
        const label = buildTakeLabel(baseTakeNumber + i + 1, event.chunkIndex);
        try {
          const handle: PluginTrackHandle = await host.createTrack({ name: label });
          await host.writeAudioClip(handle.id, event.filePath);
          await host.setTrackMute(handle.id, true);

          if (offset > 0) {
            try {
              await host.setAudioOffsetSamples(handle.id, offset);
            } catch (offsetErr) {
              console.warn('[RecorderPanel] setAudioOffsetSamples failed:', offsetErr);
            }
          }

          if (preset && preset.id !== 'none') {
            try {
              await applyVocalPreset(host, handle.id, preset);
            } catch (presetErr) {
              console.warn('[RecorderPanel] applyVocalPreset failed for new take:', presetErr);
            }
          }

          newTakes.push({
            trackId: handle.id,
            dbId: handle.dbId,
            label,
            filePath: event.filePath,
            chunkIndex: event.chunkIndex,
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(
            `[RecorderPanel] Failed to attach take for chunk ${event.chunkIndex}:`,
            msg
          );
          setError(msg);
        }
      }

      if (newTakes.length > 0) {
        setTakes((prev) => [...prev, ...newTakes]);
      }
    },
    [host, takes.length]
  );

  const recorder = useRecorder(host, { onSessionFinalized: handleSessionFinalized });

  /**
   * Switch the vocal preset and reapply to every existing take so the
   * panel's preset selector reads as a "global" knob, not just a
   * forward-looking default.
   */
  const handleVocalPresetChange = useCallback(
    async (id: VocalPresetId): Promise<void> => {
      setVocalPresetId(id);
      const preset = VOCAL_PRESETS.find((p) => p.id === id);
      if (!preset) return;
      const trackIds = takes.map((t) => t.trackId);
      if (trackIds.length === 0) return;
      const result = await applyVocalPresetToTracks(host, trackIds, preset);
      if (result.failed.length > 0) {
        console.warn(
          `[RecorderPanel] vocal preset '${id}' failed on ${result.failed.length} of ${trackIds.length} takes`,
          result.failed
        );
      }
    },
    [host, takes]
  );

  // If we lose the active scene mid-record, finalize the in-progress
  // session via cancel (drops buffered chunks rather than landing them
  // on a stale scene).
  useEffect(() => {
    if (!activeSceneId && (recorder.state === 'arming' || recorder.state === 'recording')) {
      recorder.cancel().catch(() => {
        /* best-effort */
      });
    }
  }, [activeSceneId, recorder]);

  const handleDeleteTake = useCallback(
    async (trackId: string): Promise<void> => {
      try {
        await host.deleteTrack(trackId);
        setTakes((prev) => prev.filter((t) => t.trackId !== trackId));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[RecorderPanel] Failed to delete take:', msg);
      }
    },
    [host]
  );

  const noScene = targetInfo?.sceneId == null;
  const renderLocked = targetInfo?.isRenderLocked === true;
  const noPlatformInput = platformInput == null;
  const blockedReason = !isAuthenticated
    ? 'Sign in to use the recorder'
    : !isConnected
      ? 'Audio engine not connected'
      : noPlatformInput
        ? 'Configure an input device in Audio Routing'
        : noScene
          ? 'Select a scene to record into'
          : renderLocked
            ? 'Render in progress — please wait'
            : null;

  const canRecord =
    blockedReason === null && (recorder.state === 'idle' || recorder.state === 'error');
  const isRecording = recorder.state === 'arming' || recorder.state === 'recording';

  return (
    <div className="flex flex-col gap-2 p-3" data-testid="recorder-panel">
      {/* Status + Record/Stop */}
      <div className="flex items-center justify-between">
        <div className="text-xs text-sas-muted" data-testid="recorder-status">
          {blockedReason ??
            (isRecording
              ? `Recording — ${recorder.chunksFinalized} take${recorder.chunksFinalized === 1 ? '' : 's'} captured`
              : recorder.state === 'stopping'
                ? 'Finalizing takes…'
                : 'Ready to record')}
        </div>
        {canRecord && (
          <button
            data-testid="recorder-record-button"
            onClick={() => recorder.start('')}
            className="px-2 py-0.5 text-xs font-semibold rounded border bg-red-600/20 border-red-600 text-red-400 hover:bg-red-600 hover:text-white"
          >
            ● Record
          </button>
        )}
        {isRecording && (
          <button
            data-testid="recorder-stop-button"
            onClick={() => recorder.stop()}
            className="px-2 py-0.5 text-xs font-semibold rounded border bg-sas-panel border-sas-border text-sas-muted hover:bg-sas-border"
          >
            ■ Stop
          </button>
        )}
      </div>

      {/* Platform input device readout (read-only — configured in Audio Routing) */}
      {!noPlatformInput && (
        <div className="text-[10px] text-sas-muted/60" data-testid="recorder-input-readout">
          Input: {platformInput.label}
        </div>
      )}

      {/* Vocal preset chooser */}
      <div className="flex items-center gap-2">
        <label className="text-[10px] text-sas-muted/60" htmlFor="recorder-vocal-preset">
          Vocal preset:
        </label>
        <select
          id="recorder-vocal-preset"
          data-testid="recorder-vocal-preset"
          value={vocalPresetId}
          onChange={(e) => handleVocalPresetChange(e.target.value as VocalPresetId)}
          className="sas-input flex-1 text-xs px-2 py-0.5"
        >
          {VOCAL_PRESETS.map((p) => (
            <option key={p.id} value={p.id} title={p.description}>
              {p.label}
            </option>
          ))}
        </select>
      </div>

      {/* Take list */}
      {takes.length > 0 && (
        <div className="flex flex-col gap-1" data-testid="recorder-takes-list">
          {takes.map((take) => (
            <div
              key={take.trackId}
              data-testid="recorder-take-row"
              className="flex items-center gap-2 px-2 py-1 rounded border border-sas-border bg-sas-panel-alt text-xs"
            >
              <span className="w-32 truncate text-sas-muted shrink-0" title={take.label}>
                {take.label}
              </span>
              <div className="flex-1 min-w-0 h-8">
                <WaveformView
                  host={host}
                  filePath={take.filePath}
                  className="w-full h-8"
                />
              </div>
              <button
                data-testid="recorder-take-delete"
                onClick={() => handleDeleteTake(take.trackId)}
                className="px-1 text-sas-danger/70 hover:text-sas-danger shrink-0"
                title="Delete take"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {error && (
        <div className="text-[10px] text-sas-danger" data-testid="recorder-error">
          {error}
        </div>
      )}
    </div>
  );
};

export default RecorderPanel;
