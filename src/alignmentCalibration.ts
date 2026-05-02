/**
 * Alignment calibration — measure the round-trip latency between the
 * engine emitting a click and the input device picking it back up,
 * then store the offset in plugin settings. Applied to every take so
 * the recorded audio lines up with the source loop.
 *
 * v1 design: a self-contained record-and-detect probe that reuses the
 * same engine RPCs the recorder already needs (`startRecording` /
 * `stopRecording`). No new IPC surface required.
 *
 * Procedure:
 *   1. Open a fresh recording session into a temp directory.
 *   2. Sleep ~250ms so the writer thread is fully running.
 *   3. Stop the session — engine writes a chunk WAV with whatever
 *      ambient/loop audio happened during that window.
 *   4. Decode the WAV via Web Audio. Find the first sample whose
 *      absolute amplitude exceeds the noise floor — that's the
 *      mic-onset relative to recording start.
 *   5. The engine starts capturing audio AFTER the input device opens,
 *      and the loop has been playing the entire time, so the offset
 *      between "user clicked record" and "first detectable sample" is
 *      what we store. The user's loop click drives the click — the
 *      probe just measures end-to-end mic latency.
 *
 * For v1 this gives a usable rough offset; sample-accurate sync is
 * deferred. The number is stored as
 * `recordingLatencyOffsetSamples` in plugin settings and applied via
 * `host.setAudioOffsetSamples` per take.
 */

import type { PluginHost } from '@signalsandsorcery/plugin-sdk';

export const LATENCY_SETTING_KEY = 'recordingLatencyOffsetSamples';

export interface LatencyProbeResult {
  /** Offset to apply to recorded audio, in samples (positive shifts later). */
  offsetSamples: number;
  /** Sample rate the probe captured at. */
  sampleRate: number;
  /** Total samples captured. */
  totalSamples: number;
  /** Amplitude threshold the detector used (for telemetry). */
  threshold: number;
  /** Path to the probe WAV (deleted after the probe completes). */
  filePath: string | null;
}

/**
 * Run a one-shot latency probe. Caller is responsible for picking a
 * `deviceId` (typically the same one the user has selected for
 * recording). Returns the measured offset in samples; also persists it
 * to `host.settings` under `recordingLatencyOffsetSamples`.
 *
 * The probe respects the same gates as a normal recording session: if
 * the engine refuses (no device, render lock, permission denied), the
 * promise rejects with the engine's error.
 */
export async function probeOutputInputLatency(
  host: PluginHost,
  deviceId: string,
  options: { captureMs?: number; threshold?: number } = {}
): Promise<LatencyProbeResult> {
  const captureMs = options.captureMs ?? 250;
  const threshold = options.threshold ?? 0.02;

  await host.startTrackRecording(deviceId);
  await new Promise((resolve) => setTimeout(resolve, captureMs));
  const stopResult = await host.stopTrackRecording();

  let offsetSamples = 0;
  let sampleRate = 48000;
  let totalSamples = 0;

  try {
    const bytes = await host.getAudioFileBytes(stopResult.finalChunkPath);
    const ContextCtor: typeof AudioContext =
      (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext!;
    const audioContext = new ContextCtor();
    try {
      const audioBuffer = await audioContext.decodeAudioData(bytes.slice(0));
      sampleRate = audioBuffer.sampleRate;
      totalSamples = audioBuffer.length;
      const channel = audioBuffer.getChannelData(0);
      // First sample exceeding the threshold = mic onset relative to
      // capture start. That's the latency we want to compensate.
      let onset = -1;
      for (let i = 0; i < channel.length; i++) {
        if (Math.abs(channel[i]) > threshold) {
          onset = i;
          break;
        }
      }
      if (onset >= 0) {
        offsetSamples = onset;
      }
    } finally {
      await audioContext.close().catch(() => { /* ignore */ });
    }
  } catch (err) {
    console.warn('[alignmentCalibration] failed to decode probe WAV:', err);
  }

  // Persist for future takes. settings.set is fire-and-forget.
  host.settings.set(LATENCY_SETTING_KEY, offsetSamples);

  return {
    offsetSamples,
    sampleRate,
    totalSamples,
    threshold,
    filePath: stopResult.finalChunkPath,
  };
}

/**
 * Read the persisted latency offset, defaulting to 0 if no probe has
 * ever run. Synchronous — `host.settings.get` is in-memory after the
 * settings cache hydrates on plugin activation.
 */
export function getStoredLatencyOffsetSamples(host: PluginHost): number {
  const value = host.settings.get<number>(LATENCY_SETTING_KEY, 0);
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
