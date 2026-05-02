/**
 * RecorderPanel — top-level UI for the Recorder plugin.
 *
 * Wires `useRecorder` to a Record/Stop button, an input device picker,
 * and a list of take rows. Each finalized chunk creates a NEW audio
 * track via `host.createTrack`, places the WAV via `host.writeAudioClip`,
 * and immediately mutes it (`host.setTrackMute(id, true)`) so subsequent
 * loops don't bleed.
 *
 * Take rows use the refactored AudioTrackInput in displayMode='take'.
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
import {
  probeOutputInputLatency,
  getStoredLatencyOffsetSamples,
} from './alignmentCalibration';

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

/**
 * Take counter — engineers expect take numbers to start at 1, not 0.
 */
function buildTakeLabel(takeNumber: number, chunkIndex: number): string {
  return `Take ${takeNumber} · chunk ${chunkIndex + 1}`;
}

export const RecorderPanel: React.FC<PluginUIProps> = ({
  host,
  activeSceneId,
  isAuthenticated,
  isConnected,
}) => {
  const [devices, setDevices] = useState<AudioInputDevice[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [targetInfo, setTargetInfo] = useState<RecordingTargetInfo | null>(null);
  const [takes, setTakes] = useState<Take[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [vocalPresetId, setVocalPresetId] = useState<VocalPresetId>('none');
  const vocalPresetIdRef = useRef<VocalPresetId>('none');
  vocalPresetIdRef.current = vocalPresetId;
  const [latencyOffsetSamples, setLatencyOffsetSamples] = useState<number>(() =>
    getStoredLatencyOffsetSamples(host)
  );
  const latencyOffsetRef = useRef<number>(latencyOffsetSamples);
  latencyOffsetRef.current = latencyOffsetSamples;
  const [calibrating, setCalibrating] = useState(false);

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

  // Enumerate input devices once on mount + every time the panel re-mounts.
  useEffect(() => {
    let cancelled = false;
    host
      .getAudioInputDevices()
      .then((list) => {
        if (cancelled) return;
        setDevices(list);
        // Pre-select the system default if no manual choice has been made.
        const def = list.find((d) => d.isDefault) ?? list[0];
        if (def && !selectedDeviceId) {
          setSelectedDeviceId(def.deviceId);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
    // selectedDeviceId intentionally NOT in deps — we only seed on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host]);

  const handleChunkFinalized = useCallback(
    async (event: RecordingChunkFinalizedEvent): Promise<void> => {
      try {
        const label = buildTakeLabel(takes.length + 1, event.chunkIndex);
        const handle: PluginTrackHandle = await host.createTrack({ name: label });
        await host.writeAudioClip(handle.id, event.filePath);
        await host.setTrackMute(handle.id, true);

        // Read the LATEST offset / preset via refs so we don't have to
        // re-subscribe the chunk listener every time these change.
        const offset = latencyOffsetRef.current;
        const presetId = vocalPresetIdRef.current;

        // Apply the calibrated latency offset so the take aligns with
        // the source loop. Best-effort: a missing offset is benign.
        if (offset > 0) {
          try {
            await host.setAudioOffsetSamples(handle.id, offset);
          } catch (offsetErr) {
            console.warn('[RecorderPanel] setAudioOffsetSamples failed:', offsetErr);
          }
        }

        // Apply the currently-selected vocal preset to the new take so
        // unmuting it produces the intended sound. Best-effort: errors
        // here are non-fatal — the take still lands.
        const preset = VOCAL_PRESETS.find((p) => p.id === presetId);
        if (preset && preset.id !== 'none') {
          try {
            await applyVocalPreset(host, handle.id, preset);
          } catch (presetErr) {
            console.warn('[RecorderPanel] applyVocalPreset failed for new take:', presetErr);
          }
        }

        const newTake: Take = {
          trackId: handle.id,
          dbId: handle.dbId,
          label,
          filePath: event.filePath,
          chunkIndex: event.chunkIndex,
        };
        setTakes((prev) => [...prev, newTake]);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[RecorderPanel] Failed to attach take:', msg);
        setError(msg);
      }
    },
    [host, takes.length]
  );

  const recorder = useRecorder(host, { onChunkFinalized: handleChunkFinalized });

  const handleCalibrate = useCallback(async (): Promise<void> => {
    if (calibrating) return;
    if (!selectedDeviceId) {
      setError('Select an input device before calibrating');
      return;
    }
    setCalibrating(true);
    setError(null);
    try {
      const result = await probeOutputInputLatency(host, selectedDeviceId);
      setLatencyOffsetSamples(result.offsetSamples);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Calibration failed: ${msg}`);
    } finally {
      setCalibrating(false);
    }
  }, [host, selectedDeviceId, calibrating]);

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

  // If we lose the active scene mid-record, finalize the in-progress take
  // (it lands on the original scene via the host's grace track behavior).
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
  const noDevice = devices.length === 0;
  const blockedReason = !isAuthenticated
    ? 'Sign in to use the recorder'
    : !isConnected
      ? 'Audio engine not connected'
      : noScene
        ? 'Select a scene to record into'
        : renderLocked
          ? 'Render in progress — please wait'
          : noDevice
            ? 'No microphone detected'
            : null;

  const canRecord =
    blockedReason === null && (recorder.state === 'idle' || recorder.state === 'error');
  const isRecording = recorder.state === 'arming' || recorder.state === 'recording';

  return (
    <div className="flex flex-col gap-2 p-3" data-testid="recorder-panel">
      {/* Status */}
      <div className="flex items-center justify-between">
        <div className="text-xs text-sas-muted" data-testid="recorder-status">
          {blockedReason ?? `${recorder.state}${isRecording ? ' · ' + recorder.chunksFinalized + ' takes' : ''}`}
        </div>
        {canRecord && (
          <button
            data-testid="recorder-record-button"
            onClick={() => recorder.start(selectedDeviceId)}
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

      {/* Input device picker */}
      {!noDevice && (
        <div className="flex items-center gap-2">
          <label className="text-[10px] text-sas-muted/60" htmlFor="recorder-device-select">
            Input:
          </label>
          <select
            id="recorder-device-select"
            data-testid="recorder-device-select"
            value={selectedDeviceId}
            onChange={(e) => setSelectedDeviceId(e.target.value)}
            disabled={isRecording}
            className="sas-input flex-1 text-xs px-2 py-0.5"
          >
            {devices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label} {d.isDefault ? '(default)' : ''}
              </option>
            ))}
          </select>
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

      {/* Latency calibration */}
      {!noDevice && (
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-sas-muted/60">
            Latency: {latencyOffsetSamples > 0 ? `${latencyOffsetSamples} samples` : 'uncalibrated'}
          </span>
          <button
            data-testid="recorder-calibrate-button"
            onClick={() => handleCalibrate()}
            disabled={calibrating || isRecording || !selectedDeviceId}
            className="ml-auto px-2 py-0.5 text-[10px] rounded border border-sas-border bg-sas-panel-alt text-sas-muted hover:border-sas-accent hover:text-sas-accent disabled:opacity-50 disabled:cursor-not-allowed"
            title="Probe round-trip mic latency and store the offset for future takes"
          >
            {calibrating ? 'Calibrating…' : 'Calibrate'}
          </button>
        </div>
      )}

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
