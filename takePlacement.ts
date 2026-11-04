/**
 * Recorded-take placement (S-473): the timeline offset of each take, in
 * ENGINE frames relative to the loop start, as passed to
 * `host.setAudioOffsetSamples` (positive = later, negative = earlier).
 *
 * Inputs and their units:
 *  - `latencyOffsetSamples` (`host.getRecordingLatencyOffsetSamples()`): how
 *    many INPUT-DEVICE frames late the mic hears the loop (the calibration
 *    probe counts frames in the input WAV). The take is that late, so it is
 *    shifted EARLIER: the latency is always subtracted.
 *  - `recorderSampleStart` / `recorderSampleEnd`: the chunk's first and
 *    last-plus-one frame, in INPUT-DEVICE frames counted from the take's
 *    first captured frame. `chunk.sampleRate` is the input device's rate.
 *  - `boundaryHostTimeNs` >= 0: a host-time mark (a loop wrap) CLOSED this
 *    chunk; -1 / undefined: Stop, a device loss or a legacy mark closed it.
 *    The mark carries no latency term, so the calibrated offset still
 *    applies (ADR 0010 D5/D6).
 *
 * Placement, per chunk:
 *  1. Opened by a boundary: the previous chunk (chunkIndex - 1) was closed by
 *     a host-time mark and ends exactly where this one starts. The split
 *     frame IS the loop start, so the take starts at 0.
 *  2. Else closed by a boundary (normally chunk 0, which starts when Record
 *     was pressed): its END sits on the loop wrap, so it starts at
 *     `loopLength - length`. Signed and never folded with a modulo: a chunk
 *     three frames longer than a loop starts three frames early, not almost a
 *     loop late; a multi-pass chunk puts its LAST pass in the loop window.
 *  3. Else (no fields, which is what today's host sends): latency only.
 *  Then subtract the latency. The result is never clamped here.
 *
 * Every input-device frame count is converted to engine frames by the two
 * rates before it meets the loop length.
 */
import type { RecordingChunkFinalizedEvent, RecordingTargetInfo } from '@signalsandsorcery/plugin-sdk';
import { barsToSeconds, tryParseTimeSignature } from '@signalsandsorcery/plugin-sdk';

export type PlacementTarget = Pick<RecordingTargetInfo, 'engineSampleRate' | 'bpm' | 'bars' | 'timeSignature'>;

const DEFAULT_ENGINE_RATE = 48000;
const DEFAULT_BPM = 120;

function engineRateOf(target: PlacementTarget | null): number {
  return target && target.engineSampleRate > 0 ? target.engineSampleRate : DEFAULT_ENGINE_RATE;
}

/**
 * The active scene's loop length in engine frames, from its bars, BPM
 * (quarter-note) and meter. An absent or malformed meter is 4/4 (older hosts).
 * Null without scene bars.
 */
export function loopLengthEngineSamples(target: PlacementTarget | null): number | null {
  if (!target || target.bars == null || !(target.bars > 0)) return null;
  const bpm = target.bpm > 0 ? target.bpm : DEFAULT_BPM;
  const meter = tryParseTimeSignature(target.timeSignature) ? target.timeSignature : undefined;
  return Math.round(barsToSeconds(target.bars, bpm, meter) * engineRateOf(target));
}

function isFrame(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

function closedByMark(c: RecordingChunkFinalizedEvent): boolean {
  return isFrame(c.boundaryHostTimeNs) && isFrame(c.recorderSampleStart) && isFrame(c.recorderSampleEnd)
    && c.recorderSampleEnd > c.recorderSampleStart;
}

export function computeTakeOffsets(
  chunks: ReadonlyArray<RecordingChunkFinalizedEvent>,
  latencyOffsetSamples: number,
  target: PlacementTarget | null,
): number[] {
  const engineRate = engineRateOf(target);
  const loopLength = loopLengthEngineSamples(target);
  const byIndex = new Map<number, RecordingChunkFinalizedEvent>();
  for (const c of chunks) byIndex.set(c.chunkIndex, c);

  return chunks.map((c) => {
    const inputRate = c.sampleRate > 0 ? c.sampleRate : engineRate;
    const toEngine = (inputFrames: number): number => Math.round((inputFrames * engineRate) / inputRate);
    const latency = Number.isFinite(latencyOffsetSamples) ? toEngine(latencyOffsetSamples) : 0;

    let start = 0;
    const prev = byIndex.get(c.chunkIndex - 1);
    const openedByBoundary = prev !== undefined && closedByMark(prev)
      && isFrame(c.recorderSampleStart) && c.recorderSampleStart === prev.recorderSampleEnd;
    if (!openedByBoundary && loopLength !== null && closedByMark(c)) {
      const length = toEngine((c.recorderSampleEnd as number) - (c.recorderSampleStart as number));
      start = loopLength - length;
    }
    // `0 - latency` would be -0 for an uncalibrated take; keep a plain 0.
    return start - latency || 0;
  });
}
