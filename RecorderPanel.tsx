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

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  PluginUIProps,
  AudioInputDevice,
  RecordingTargetInfo,
  RecordingChunkFinalizedEvent,
  PluginTrackHandle,
} from '@signalsandsorcery/plugin-sdk';
import { TrackRow } from '@signalsandsorcery/plugin-sdk';
import { useRecorder } from './useRecorder';
import { computeTakeOffsets, loopLengthEngineSamples } from './takePlacement';
// Waveform / audio-clip UI toolkit — promoted to the SDK (W9), reached through
// the host contract instead of a relative app path.
import {
  WaveformView,
  LevelMeter,
  ScrollingWaveform,
  analyzeWavPeak,
  type PeakAnalysis,
  OffsetScrubber,
  synthesizeCuePoints,
} from '@signalsandsorcery/plugin-sdk';

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
  /** Peak analysis (Phase 8.10) — populated async after take lands. */
  peak?: PeakAnalysis;
  /** Engine-mirrored mute / solo / volume / pan, kept in sync via
   *  host.onTrackStateChange. Initial: muted=true so takes don't blast
   *  out of the cue mix immediately after recording. */
  runtimeState: { muted: boolean; solo: boolean; volume: number; pan: number };
  /** Whether the track drawer is open for this take's row (FX tab —
   *  third-party external FX via the SDK's TrackExternalFxSection). */
  drawerOpen: boolean;
  /** Current sample offset on the audio clip — what the OffsetScrubber
   *  edits. Initialized to the value that handleSessionFinalized
   *  applied (latency compensation + sample-perfect alignment); user
   *  drags refine it via host.setAudioOffsetSamples. */
  offsetSamples: number;
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

  // Phase 8.10 — live input level polled at ~30Hz so the recorder
  // panel itself can show a meter + scrolling waveform without forcing
  // the user to look at the Audio Routing panel. Mirrors the polling
  // loop in AudioRoutingContext but stays in plugin-host land
  // (no direct context dependency — the recorder is plugin-scoped).
  const [meterLevelDb, setMeterLevelDb] = useState(-120);
  const [meterActive, setMeterActive] = useState(false);
  const [meterClipped, setMeterClipped] = useState(false);
  // Ref mirror of meterLevelDb so the scrolling waveform can pull
  // the freshest value per RAF without re-rendering on each tick.
  const meterLevelDbRef = useRef(-120);
  meterLevelDbRef.current = meterLevelDb;

  // Refresh target info when scene changes; gates Record button.
  // Also re-fetch on input device changes — `canRecordSamplePerfect` and
  // `recordingCompatibilityReason` depend on the active input device, so
  // without this subscription the panel keeps reporting
  // "input_device_not_configured" after the user picks a device in
  // Audio Routing (the meter and label update via platformInput, but the
  // record button stays gated).
  useEffect(() => {
    let cancelled = false;
    const fetchTarget = (): void => {
      host
        .getRecordingTargetInfo()
        .then((info) => {
          if (!cancelled) setTargetInfo(info);
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(err instanceof Error ? err.message : String(err));
        });
    };
    fetchTarget();
    const unsubscribe = host.onInputDeviceChange(fetchTarget);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [host, activeSceneId]);

  // Read the platform-configured input device on mount AND whenever
  // it changes (user picks a new device in Audio Routing). Without the
  // subscription, this panel would still show "Configure an input
  // device in Audio Routing" until the next remount / app restart.
  useEffect(() => {
    let cancelled = false;
    const fetchDevice = (): void => {
      host
        .getCurrentInputDevice()
        .then((device) => {
          if (!cancelled) setPlatformInput(device);
        })
        .catch(() => {
          // Fall through — UI shows "configure input" hint.
        });
    };
    fetchDevice();
    const unsubscribe = host.onInputDeviceChange(fetchDevice);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [host]);

  // Engine-mirrored runtime state for owned take tracks. Subscribed
  // once for the lifetime of the panel so cross-track solos and
  // remote (CLI / API) volume changes reflect in the take rows.
  useEffect(() => {
    const unsub = host.onTrackStateChange((trackId, state) => {
      setTakes((prev) =>
        prev.map((t) =>
          t.trackId === trackId
            ? {
                ...t,
                runtimeState: {
                  muted: state.muted,
                  solo: state.solo,
                  volume: state.volume,
                  pan: state.pan,
                },
              }
            : t
        )
      );
    });
    return unsub;
  }, [host]);

  // Phase 8.10 — poll the engine input level at ~30Hz to drive the
  // panel-local meter + scrolling waveform. We can't share the
  // AudioRoutingContext loop from a plugin (plugin-scoped, no
  // renderer-context dependency), so the recorder polls separately.
  // The cost is one extra IPC call per ~33ms — cheap.
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async (): Promise<void> => {
      if (stopped) return;
      try {
        const level = await host.getRecordingInputLevel();
        if (!stopped) {
          setMeterActive(level.active);
          setMeterLevelDb(level.active ? level.peakDb : -120);
          if (level.clipped) setMeterClipped(true);
        }
      } catch {
        // Engine may not be up yet; just retry next tick.
      }
      if (!stopped) {
        timer = setTimeout(tick, 33);
      }
    };
    tick();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [host]);

  const handleClearClip = useCallback(async (): Promise<void> => {
    try {
      await host.clearRecordingInputClipIndicator();
      setMeterClipped(false);
    } catch (err) {
      console.warn('[RecorderPanel] clearRecordingInputClipIndicator failed:', err);
    }
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

      // Read the platform's calibrated round-trip latency offset ONCE
      // at the start of the batch — applied as a constant compensation
      // to every take so the recorded vocal lines up with what the user
      // HEARD (not when their voice arrived at the mic, which was
      // L_rt samples later).
      let latencyOffset = 0;
      try {
        latencyOffset = await host.getRecordingLatencyOffsetSamples();
      } catch (err) {
        console.warn('[RecorderPanel] getRecordingLatencyOffsetSamples failed:', err);
      }

      // Per-take placement (S-473): sample-perfect when the engine
      // supplied the chunk's frames and a host-time boundary, else the
      // latency alone. Pure math in takePlacement.ts (tested there).
      const takeOffsets = computeTakeOffsets(chunks, latencyOffset, targetInfo);

      const baseTakeNumber = takes.length;
      const newTakes: Take[] = [];

      for (let i = 0; i < chunks.length; i++) {
        const event = chunks[i];
        const label = buildTakeLabel(baseTakeNumber + i + 1, event.chunkIndex);
        try {
          const handle: PluginTrackHandle = await host.createTrack({ name: label });
          await host.writeAudioClip(handle.id, event.filePath);
          await host.setTrackMute(handle.id, true);

          // Signed: the host persists it as given (the OffsetScrubber
          // shows the calibrated trim).
          const takeOffset = takeOffsets[i];

          if (takeOffset !== 0) {
            try {
              await host.setAudioOffsetSamples(handle.id, takeOffset);
            } catch (offsetErr) {
              console.warn('[RecorderPanel] setAudioOffsetSamples failed:', offsetErr);
            }
          }

          newTakes.push({
            trackId: handle.id,
            dbId: handle.dbId,
            label,
            filePath: event.filePath,
            chunkIndex: event.chunkIndex,
            runtimeState: { muted: true, solo: false, volume: 1, pan: 0 },
            drawerOpen: false,
            offsetSamples: takeOffset,
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

        // Phase 8.10 — kick off peak analysis for each new take so the
        // row can render a peak/clip badge. Best-effort: rows render
        // without the badge until the analysis resolves. Done per-take
        // to surface results progressively rather than all-at-once.
        for (const take of newTakes) {
          analyzeWavPeak(host, take.filePath)
            .then((peak) => {
              setTakes((prev) =>
                prev.map((t) => (t.trackId === take.trackId ? { ...t, peak } : t))
              );
            })
            .catch((err) => {
              console.warn(
                `[RecorderPanel] peak analysis failed for ${take.label}:`,
                err
              );
            });
        }
      }
    },
    [host, takes.length, targetInfo]
  );

  const recorder = useRecorder(host, { onSessionFinalized: handleSessionFinalized });

  // If we lose the active scene mid-record, drop the in-progress
  // session via cancel rather than landing chunks on a stale scene.
  // Recorder Stop never touches the deck (asymmetric rule below), so
  // we don't stop loop-a here either.
  useEffect(() => {
    if (!activeSceneId && (recorder.state === 'arming' || recorder.state === 'recording')) {
      recorder.cancel().catch(() => {
        /* best-effort */
      });
    }
  }, [activeSceneId, recorder]);

  // Asymmetric stop rule: stopping LOOP-A playback (via the bottom
  // transport, scene switch, all-decks-stopped, etc.) ALSO stops an
  // in-flight recording — recording without backing playback would
  // produce takes with no anchor. The reverse is NOT true: recorder
  // Stop leaves loop-a playing so the user can keep listening or
  // queue another take.
  //
  // We use a ref to read the freshest recorder state inside the
  // engine-event callback without re-subscribing on every recorder
  // state change.
  const recorderRef = useRef(recorder);
  recorderRef.current = recorder;
  useEffect(() => {
    const unsubDeck = host.onDeckStateChanged((data) => {
      if (data.deckId !== 'loop-a' || data.property !== 'playing') return;
      if (data.value === false) {
        const r = recorderRef.current;
        if (r.state === 'arming' || r.state === 'recording') {
          r.stop().catch((err) => {
            console.warn('[RecorderPanel] auto-stop on deck pause failed:', err);
          });
        }
      }
    });
    const unsubAll = host.onAllDecksStopped(() => {
      const r = recorderRef.current;
      if (r.state === 'arming' || r.state === 'recording') {
        r.stop().catch((err) => {
          console.warn('[RecorderPanel] auto-stop on allDecksStopped failed:', err);
        });
      }
    });
    return () => {
      unsubDeck();
      unsubAll();
    };
  }, [host]);

  /**
   * Record click. Starts loop-a scene playback first (so the rapper has
   * a backing loop AND the recorder gets onDeckBoundary events for
   * sample-aligned chunk slicing), then arms recording. Always
   * restarts loop-a from sample 0 — that's what makes chunk 0 line up
   * with loop position 0, which the offset math in
   * handleSessionFinalized depends on. The bottom transport's play
   * button updates automatically via the deck-state engine event.
   */
  const handleRecordClick = useCallback(async (): Promise<void> => {
    if (!activeSceneId) return;
    try {
      await host.deckPlay('loop-a', activeSceneId, 'scene');
    } catch (err) {
      console.warn('[RecorderPanel] failed to start scene playback:', err);
    }
    await recorder.start('');
  }, [activeSceneId, recorder, host]);

  /**
   * Stop click. Stops loop-a IMMEDIATELY (fire-and-forget) so audio
   * silences within an IPC round-trip, then finalizes the recording
   * session in parallel. Awaiting recorder.stop first would block the
   * deck stop behind the take-finalization batch (per chunk:
   * createTrack + writeAudioClip + setTrackMute + setAudioOffsetSamples,
   * plus a debounced LoopWorkstation reload that walks every track in
   * the scene), which felt like a UI freeze.
   *
   * The cross-direction listener (deck stop → recorder stop) still
   * covers the other half of the symmetric rule — e.g. when the user
   * presses Stop on the bottom transport instead. Calling
   * recorder.stop() here AND from the listener is safe: the hook's
   * stop is idempotent (returns early when state isn't recording).
   */
  const handleStopClick = useCallback((): void => {
    host.deckStop('loop-a').catch((err) => {
      console.warn('[RecorderPanel] failed to stop scene playback:', err);
    });
    recorder.stop().catch((err) => {
      console.warn('[RecorderPanel] recorder stop failed:', err);
    });
  }, [recorder, host]);

  // Take preview playback — drives the EXISTING Tracktion track for
  // the take through the engine, so playback honors any FX, the
  // recorder's per-take offset, and stays sample-locked to the rest
  // of the scene. ▶ on a take = solo it + ensure loop-a is playing;
  // ■ clears the solo. Solo (vs. unmuting) means only this take is
  // audible during preview, so the user can A/B between takes
  // without other backing material in the way.
  const [previewingTrackId, setPreviewingTrackId] = useState<string | null>(null);

  const togglePreviewTake = useCallback(
    async (take: Take): Promise<void> => {
      // Same row toggles back to stopped: clear solo, leave loop-a
      // playing (the user can keep listening or queue another take).
      if (previewingTrackId === take.trackId) {
        try {
          await host.setTrackSolo(take.trackId, false);
        } catch (err) {
          console.warn('[RecorderPanel] preview unsolo failed:', err);
        }
        setPreviewingTrackId(null);
        return;
      }
      // Different row was previewing — clear its solo first so the
      // engine's any-solo logic doesn't keep both audible.
      if (previewingTrackId) {
        try {
          await host.setTrackSolo(previewingTrackId, false);
        } catch {
          /* best-effort */
        }
      }
      try {
        await host.setTrackSolo(take.trackId, true);
        if (activeSceneId) {
          // Always (re)start loop-a with the active scene — the user
          // wants to hear this take from the loop start. The bottom
          // transport reflects the new playing state via
          // engine.onDeckStateChanged.
          await host.deckPlay('loop-a', activeSceneId, 'scene');
        }
        setPreviewingTrackId(take.trackId);
      } catch (err) {
        console.warn('[RecorderPanel] take preview failed:', err);
        setPreviewingTrackId(null);
      }
    },
    [host, previewingTrackId, activeSceneId]
  );

  // When the deck stops (bottom transport, scene switch, etc.), the
  // soloed take is no longer "previewing" — clear the indicator so
  // the ▶ icon comes back. The cross-direction listener already
  // unsubscribes the recorder; we just track UI state here.
  useEffect(() => {
    const unsub = host.onDeckStateChanged((data) => {
      if (data.deckId === 'loop-a' && data.property === 'playing' && data.value === false) {
        setPreviewingTrackId(null);
      }
    });
    return unsub;
  }, [host]);

  const handleDeleteTake = useCallback(
    async (trackId: string): Promise<void> => {
      try {
        await host.deleteTrack(trackId);
        setTakes((prev) => prev.filter((t) => t.trackId !== trackId));
        if (previewingTrackId === trackId) {
          setPreviewingTrackId(null);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[RecorderPanel] Failed to delete take:', msg);
      }
    },
    [host, previewingTrackId]
  );

  // Per-take mute/solo/volume/pan handlers. Optimistic UI: update the
  // panel's runtimeState immediately, then call the host. On error,
  // roll back. The eventual host.onTrackStateChange callback (set up
  // earlier) reconciles to engine truth.
  const updateTakeRuntime = useCallback(
    (trackId: string, partial: Partial<Take['runtimeState']>): void => {
      setTakes((prev) =>
        prev.map((t) =>
          t.trackId === trackId
            ? { ...t, runtimeState: { ...t.runtimeState, ...partial } }
            : t
        )
      );
    },
    []
  );

  const handleTakeMuteToggle = useCallback(
    async (trackId: string): Promise<void> => {
      const take = takes.find((t) => t.trackId === trackId);
      if (!take) return;
      const newMuted = !take.runtimeState.muted;
      updateTakeRuntime(trackId, { muted: newMuted });
      try {
        await host.setTrackMute(trackId, newMuted);
      } catch (err) {
        updateTakeRuntime(trackId, { muted: !newMuted });
        console.warn('[RecorderPanel] setTrackMute failed:', err);
      }
    },
    [takes, host, updateTakeRuntime]
  );

  const handleTakeSoloToggle = useCallback(
    async (trackId: string): Promise<void> => {
      const take = takes.find((t) => t.trackId === trackId);
      if (!take) return;
      const newSolo = !take.runtimeState.solo;
      updateTakeRuntime(trackId, { solo: newSolo });
      try {
        await host.setTrackSolo(trackId, newSolo);
      } catch (err) {
        updateTakeRuntime(trackId, { solo: !newSolo });
        console.warn('[RecorderPanel] setTrackSolo failed:', err);
      }
    },
    [takes, host, updateTakeRuntime]
  );

  const handleTakeVolumeChange = useCallback(
    async (trackId: string, volume: number): Promise<void> => {
      updateTakeRuntime(trackId, { volume });
      try {
        await host.setTrackVolume(trackId, volume);
      } catch (err) {
        console.warn('[RecorderPanel] setTrackVolume failed:', err);
      }
    },
    [host, updateTakeRuntime]
  );

  const handleTakePanChange = useCallback(
    async (trackId: string, pan: number): Promise<void> => {
      updateTakeRuntime(trackId, { pan });
      try {
        await host.setTrackPan(trackId, pan);
      } catch (err) {
        console.warn('[RecorderPanel] setTrackPan failed:', err);
      }
    },
    [host, updateTakeRuntime]
  );

  // OffsetScrubber commit — write the new sample offset to the engine
  // and mirror it in panel state so subsequent renders reflect the
  // committed value.
  const handleTakeOffsetChange = useCallback(
    async (trackId: string, offsetSamples: number): Promise<void> => {
      setTakes((prev) =>
        prev.map((t) => (t.trackId === trackId ? { ...t, offsetSamples } : t))
      );
      try {
        await host.setAudioOffsetSamples(trackId, offsetSamples);
      } catch (err) {
        console.warn('[RecorderPanel] setAudioOffsetSamples failed:', err);
      }
    },
    [host]
  );

  // FX button on a take row — open/close the SDK track drawer (FX tab).
  // The drawer's third-party FX section (TrackExternalFxSection) reads
  // its own state through `externalFxHost`, so there is nothing to
  // refresh panel-side.
  const toggleTakeFxDrawer = useCallback((trackId: string): void => {
    setTakes((prev) =>
      prev.map((t) => (t.trackId === trackId ? { ...t, drawerOpen: !t.drawerOpen } : t))
    );
  }, []);

  // Scene loop length in engine samples — used so each take row's
  // waveform spans a full loop width (partial last chunks render with
  // a flat tail instead of being stretched to fill the row). Falls
  // back to undefined when there's no scene context, in which case
  // WaveformView fills naturally with the chunk's actual sample count.
  const loopLengthSamples: number | undefined = useMemo(() => {
    return loopLengthEngineSamples(targetInfo) ?? undefined;
  }, [targetInfo]);

  // Synthetic cue points for the OffsetScrubber. Recorder takes don't
  // have detection-derived cues (no Lyria pass), so we synthesize a
  // regular beat grid from the project BPM + bars. The scrubber uses
  // it for tick marks + snap; it's the same grid the recorder is
  // sample-locked to, so user nudges land on musically meaningful
  // boundaries.
  const projectBpm = targetInfo?.bpm && targetInfo.bpm > 0 ? targetInfo.bpm : 120;
  const cuePoints = useMemo(() => {
    if (!targetInfo || targetInfo.bars == null) return null;
    return synthesizeCuePoints({
      bpm: projectBpm,
      sampleRate: targetInfo.engineSampleRate > 0 ? targetInfo.engineSampleRate : 48000,
      bars: targetInfo.bars,
    });
  }, [targetInfo, projectBpm]);

  const noScene = targetInfo?.sceneId == null;
  const renderLocked = targetInfo?.isRenderLocked === true;
  const noPlatformInput = platformInput == null;

  // Path 2 / sample-perfect-recording gate. When the engine reports
  // that input + output devices can't be sample-aligned, refuse to
  // record. The user gets a clear explanation of *why* (different
  // devices, bluetooth, etc.) so they can fix the routing.
  const samplePerfectBlocked =
    targetInfo?.canRecordSamplePerfect === false;
  const samplePerfectReason = (() => {
    if (!samplePerfectBlocked) return null;
    switch (targetInfo?.recordingCompatibilityReason) {
      case 'different_devices_unsynced_clocks':
        return 'Recording needs input and output on the same device. Set them to match in Audio Routing.';
      case 'bluetooth_unstable_clock':
        return 'Bluetooth audio cannot stay in sync with playback. Use a wired input and output.';
      case 'input_device_not_configured':
        return 'No input device configured.';
      case 'output_device_not_configured':
        return 'No output device configured.';
      default:
        return 'Input and output devices are not clock-aligned. Recording would drift.';
    }
  })();

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
            : samplePerfectReason;

  // True when the blocker is something the user fixes in Settings →
  // Audio In / Out (missing/mismatched device). Drives the click-to-
  // open-settings affordance below.
  const blockedByAudioRouting = noPlatformInput || samplePerfectBlocked;

  const openAudioRoutingSettings = useCallback((): void => {
    window.dispatchEvent(
      new CustomEvent('openSettings', { detail: { section: 'Audio In / Out' } })
    );
  }, []);

  const canRecord =
    blockedReason === null && (recorder.state === 'idle' || recorder.state === 'error');
  const isRecording = recorder.state === 'arming' || recorder.state === 'recording';

  return (
    <div className="flex flex-col gap-2 p-3" data-testid="recorder-panel">
      {/* Status + Record/Stop */}
      <div className="flex items-center justify-between">
        <div className="text-xs text-sas-muted" data-testid="recorder-status">
          {blockedReason ? (
            blockedByAudioRouting ? (
              <button
                type="button"
                data-testid="recorder-open-audio-settings"
                onClick={openAudioRoutingSettings}
                className="text-sas-accent underline hover:text-sas-accent/80 cursor-pointer"
              >
                {blockedReason} — Open Audio Settings
              </button>
            ) : (
              blockedReason
            )
          ) : isRecording ? (
            `Recording — ${recorder.chunksFinalized} take${recorder.chunksFinalized === 1 ? '' : 's'} captured`
          ) : recorder.state === 'stopping' ? (
            'Finalizing takes…'
          ) : (
            'Ready to record'
          )}
        </div>
        {canRecord && (
          <button
            data-testid="recorder-record-button"
            onClick={handleRecordClick}
            className="px-2 py-0.5 text-xs font-semibold rounded border bg-red-600/20 border-red-600 text-red-400 hover:bg-red-600 hover:text-white"
          >
            ● Record
          </button>
        )}
        {isRecording && (
          <button
            data-testid="recorder-stop-button"
            onClick={handleStopClick}
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

      {/* Phase 8.10 — live level meter (always visible while panel is
          mounted, animates whenever the engine has the device open). */}
      {!noPlatformInput && (
        <LevelMeter
          peakDb={meterLevelDb}
          active={meterActive}
          clipped={meterClipped}
          onClearClip={handleClearClip}
          data-testid="recorder-live-meter"
        />
      )}

      {/* Phase 8.10 — scrolling waveform during recording. The wave
          freezes when not recording so the user can see the last
          take's tail without it scrolling away. */}
      {(isRecording || meterActive) && (
        <div
          className="w-full h-12 rounded border border-sas-border bg-black/40"
          data-testid="recorder-scrolling-waveform-wrap"
        >
          <ScrollingWaveform
            getPeakDb={() => meterLevelDbRef.current}
            active={isRecording}
            className="w-full h-full"
            fillStyle={isRecording ? '#dc3545' : '#6af2c5'}
          />
        </div>
      )}

      {/* Take list — uses SDK TrackRow so takes look and behave like
          AI audio tracks: M/S/volume/pan/delete. Each take is a real
          Tracktion track (created at session-finalize), so the same
          host calls back the engine. WaveformView in the contentSlot
          spans the full loop length so partial last chunks show a flat
          tail rather than being stretched to fill. */}
      {takes.length > 0 && (
        <div className="flex flex-col gap-1" data-testid="recorder-takes-list">
          {takes.map((take) => (
            <TrackRow
              key={take.trackId}
              track={{ id: take.trackId, name: take.label }}
              runtimeState={take.runtimeState}
              drawerOpen={take.drawerOpen}
              drawerTab="fx"
              accentColor="#FF6B6B"
              onMuteToggle={() => handleTakeMuteToggle(take.trackId)}
              onSoloToggle={() => handleTakeSoloToggle(take.trackId)}
              onVolumeChange={(vol) => handleTakeVolumeChange(take.trackId, vol)}
              onPanChange={(pan) => handleTakePanChange(take.trackId, pan)}
              onDelete={() => handleDeleteTake(take.trackId)}
              externalFxHost={host}
              onToggleFxDrawer={() => toggleTakeFxDrawer(take.trackId)}
              contentSlot={
                <div
                  data-testid="recorder-take-row"
                  className="flex flex-col gap-1 px-2 py-1 min-w-0"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <button
                      type="button"
                      data-testid="recorder-take-preview"
                      onClick={() => togglePreviewTake(take)}
                      title={previewingTrackId === take.trackId ? 'Stop preview' : 'Preview take'}
                      className="shrink-0 w-6 h-6 rounded-full border border-sas-border flex items-center justify-center text-[11px] hover:border-sas-accent hover:text-sas-accent"
                    >
                      {previewingTrackId === take.trackId ? '■' : '▶'}
                    </button>
                    <span
                      className="w-24 truncate text-[10px] text-sas-muted shrink-0"
                      title={take.label}
                    >
                      {take.label}
                    </span>
                    <div className="flex-1 min-w-0 h-8">
                      <WaveformView
                        host={host}
                        filePath={take.filePath}
                        className="w-full h-8"
                        targetSamples={loopLengthSamples}
                      />
                    </div>
                    {take.peak && (
                      <span
                        data-testid="recorder-take-peak"
                        className={`shrink-0 px-1 py-0.5 rounded text-[9px] font-semibold tabular-nums ${
                          take.peak.clipped
                            ? 'bg-sas-danger text-white'
                            : take.peak.peakDb > -3
                              ? 'bg-yellow-500/30 text-yellow-300'
                              : 'bg-sas-panel text-sas-muted'
                        }`}
                        title={
                          take.peak.clipped
                            ? `CLIPPED — peak ${take.peak.peakDb.toFixed(1)} dBFS`
                            : `Peak ${take.peak.peakDb.toFixed(1)} dBFS`
                        }
                      >
                        {take.peak.clipped ? 'CLIP' : `${take.peak.peakDb.toFixed(0)}dB`}
                      </span>
                    )}
                  </div>
                  <OffsetScrubber
                    cuePoints={cuePoints}
                    offsetSamples={take.offsetSamples}
                    projectBpm={projectBpm}
                    onChange={(n) => handleTakeOffsetChange(take.trackId, n)}
                  />
                </div>
              }
            />
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
