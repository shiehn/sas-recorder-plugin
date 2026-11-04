/**
 * S-473: recorded-take placement. Pure math, no host.
 *
 * Conventions under test:
 *  - `setAudioOffsetSamples`: positive = later, negative = earlier (SDK doc).
 *  - The calibrated latency is how many input-device frames LATE the mic
 *    hears the loop, so compensation shifts the take EARLIER (negative).
 *  - `recorderSampleStart` / `End` are input-device frames counted from the
 *    take's first captured frame; `boundaryHostTimeNs` (>= 0) is the mark
 *    that CLOSED the chunk, -1 / undefined when stop (or a legacy mark) did.
 *  - Offsets are engine frames, relative to the loop start.
 */
import type { RecordingChunkFinalizedEvent } from '@signalsandsorcery/plugin-sdk';
import { computeTakeOffsets, loopLengthEngineSamples, type PlacementTarget } from '../takePlacement';

const SR = 48000;
// 4 bars of 4/4 at 120 BPM = 8 s = 384000 engine frames.
const T44: PlacementTarget = { engineSampleRate: SR, bpm: 120, bars: 4, timeSignature: '4/4' };
const L = 384000;
const LAT = 240;

function chunk(
  chunkIndex: number,
  fields: Partial<RecordingChunkFinalizedEvent> = {},
): RecordingChunkFinalizedEvent {
  return {
    filePath: `/tmp/take-${chunkIndex}.wav`,
    chunkIndex,
    durationMs: 8000,
    sampleRate: SR,
    channels: 2,
    ...fields,
  };
}

/** A chunk with sample-perfect fields; `closedByMark` = a host-time mark closed it. */
function sp(
  chunkIndex: number,
  start: number,
  end: number,
  closedByMark: boolean,
  sampleRate = SR,
): RecordingChunkFinalizedEvent {
  return chunk(chunkIndex, {
    recorderSampleStart: start,
    recorderSampleEnd: end,
    boundaryHostTimeNs: closedByMark ? 1_000_000_000 + chunkIndex : -1,
    sampleRate,
  });
}

describe('fallback branch (no sample-perfect fields: what the host sends today)', () => {
  it('shifts every take EARLIER by the calibrated latency (defect: it shifted later, ~2x late)', () => {
    const offsets = computeTakeOffsets([chunk(0), chunk(1), chunk(2)], LAT, T44);
    expect(offsets).toEqual([-LAT, -LAT, -LAT]);
  });

  it('applies no offset when uncalibrated', () => {
    expect(computeTakeOffsets([chunk(0), chunk(1)], 0, T44)).toEqual([0, 0]);
  });

  it('converts the latency from input-device frames to engine frames', () => {
    // Calibrated on a 44.1 kHz input: 441 input frames = 10 ms = 480 engine frames.
    const offsets = computeTakeOffsets([chunk(0, { sampleRate: 44100 })], 441, T44);
    expect(offsets).toEqual([-480]);
  });

  it('treats -1 sentinels as absent fields', () => {
    const c = chunk(0, { recorderSampleStart: -1, recorderSampleEnd: -1, boundaryHostTimeNs: -1 });
    expect(computeTakeOffsets([c], LAT, T44)).toEqual([-LAT]);
  });

  it('returns an empty list for no chunks', () => {
    expect(computeTakeOffsets([], LAT, T44)).toEqual([]);
  });
});

describe('sample-perfect branch (fields present)', () => {
  it('lands a take opened by a loop boundary on the loop start (defect: mod loopLen put it ~a whole loop late)', () => {
    // Chunk 0 starts 1200 frames into pass 1 and is closed by the wrap after
    // pass 2; chunk 1 is one exact pass; chunk 2 is opened by a wrap and
    // closed by Stop.
    const eps = 1200;
    const c0 = sp(0, 0, 2 * L - eps, true);
    const c1 = sp(1, 2 * L - eps, 3 * L - eps, true);
    const c2 = sp(2, 3 * L - eps, 3 * L - eps + 5000, false);
    const offsets = computeTakeOffsets([c0, c1, c2], LAT, T44);
    expect(offsets[1]).toBe(-LAT);
    expect(offsets[2]).toBe(-LAT);
  });

  it('anchors the first chunk on the boundary that closed it', () => {
    // Recording began 5 frames into the loop; the first wrap closed chunk 0.
    const c0 = sp(0, 0, L - 5, true);
    const c1 = sp(1, L - 5, 2 * L - 5, true);
    expect(computeTakeOffsets([c0, c1], LAT, T44)).toEqual([5 - LAT, -LAT]);
  });

  it('keeps a multi-pass first chunk signed: its end sits on the closing boundary', () => {
    const eps = 1200;
    const c0 = sp(0, 0, 2 * L - eps, true);
    expect(computeTakeOffsets([c0], LAT, T44)).toEqual([L - (2 * L - eps) - LAT]);
  });

  it('emits negative offsets signed, never clamped to 0', () => {
    const c0 = sp(0, 0, L, true);
    const c1 = sp(1, L, 2 * L, true);
    const offsets = computeTakeOffsets([c0, c1], LAT, T44);
    expect(offsets).toEqual([-LAT, -LAT]);
    expect(offsets.every((o) => o < 0)).toBe(true);
  });

  it('a small jitter stays small (never folds to almost a loop)', () => {
    // Chunk 0 is 3 frames longer than a loop: it started 3 frames BEFORE the loop start.
    const c0 = sp(0, 0, L + 3, true);
    expect(computeTakeOffsets([c0], 0, T44)).toEqual([-3]);
    // ...and 3 frames shorter: it started 3 frames after.
    const d0 = sp(0, 0, L - 3, true);
    expect(computeTakeOffsets([d0], 0, T44)).toEqual([3]);
  });

  it('a dropped mark (two-pass chunk opened by a boundary) still lands on the loop start', () => {
    const c0 = sp(0, 0, L, true);
    const c1 = sp(1, L, 3 * L, true);
    expect(computeTakeOffsets([c0, c1], 0, T44)).toEqual([0, 0]);
  });

  it('converts input-device frames to engine frames by the two rates (defect: mixed them)', () => {
    // 44.1 kHz input, 48 kHz engine. Chunk 0 is 7 s long and closed by the
    // first wrap of an 8 s loop, so recording began 1 s (48000 engine frames) in.
    const IN = 44100;
    const c0 = sp(0, 0, 7 * IN, true, IN);
    const c1 = sp(1, 7 * IN, 15 * IN, true, IN);
    // Latency 441 input frames = 480 engine frames.
    expect(computeTakeOffsets([c0, c1], 441, T44)).toEqual([48000 - 480, -480]);
  });

  it('reads the chunks by chunkIndex, not by arrival order', () => {
    const c0 = sp(0, 0, L - 5, true);
    const c1 = sp(1, L - 5, 2 * L - 5, true);
    expect(computeTakeOffsets([c1, c0], 0, T44)).toEqual([0, 5]);
  });

  it('a chunk opened by a stop/legacy mark and closed by stop falls back to the latency only', () => {
    const c0 = sp(0, 0, 1000, false);
    expect(computeTakeOffsets([c0], LAT, T44)).toEqual([-LAT]);
  });

  it('without a loop length, a boundary-opened chunk still lands on the loop start', () => {
    const noBars: PlacementTarget = { ...T44, bars: null };
    const c0 = sp(0, 0, L - 5, true);
    const c1 = sp(1, L - 5, 2 * L - 5, true);
    // Chunk 0 needs the loop length (closing anchor) → latency only.
    expect(computeTakeOffsets([c0, c1], LAT, noBars)).toEqual([-LAT, -LAT]);
  });

  it('a gap between chunks (non-contiguous samples) does not trust the opening boundary', () => {
    const c0 = sp(0, 0, L, true);
    const c1 = sp(1, L + 100, 2 * L, true); // closed by a mark: closing anchor applies
    expect(computeTakeOffsets([c0, c1], 0, T44)).toEqual([0, 100]);
  });
});

describe('loop length from the scene meter (defect: assumed 4/4)', () => {
  it('4/4: 4 bars at 120 BPM = 8 s', () => {
    expect(loopLengthEngineSamples(T44)).toBe(L);
  });

  it('6/8: 4 bars = 12 quarter notes = 6 s', () => {
    expect(loopLengthEngineSamples({ ...T44, timeSignature: '6/8' })).toBe(6 * SR);
  });

  it('3/4: 4 bars = 12 quarter notes = 6 s', () => {
    expect(loopLengthEngineSamples({ ...T44, timeSignature: '3/4' })).toBe(6 * SR);
  });

  it('absent or malformed meter = 4/4 (older hosts)', () => {
    expect(loopLengthEngineSamples({ ...T44, timeSignature: undefined })).toBe(L);
    expect(loopLengthEngineSamples({ ...T44, timeSignature: 'banana' })).toBe(L);
  });

  it('no scene bars = no loop length', () => {
    expect(loopLengthEngineSamples({ ...T44, bars: null })).toBeNull();
    expect(loopLengthEngineSamples(null)).toBeNull();
  });

  it('places the first take by the real meter', () => {
    // 3/4, 4 bars at 120 BPM = 288000 frames; recording began 5 frames in.
    const t34: PlacementTarget = { ...T44, timeSignature: '3/4' };
    const c0 = sp(0, 0, 288000 - 5, true);
    expect(computeTakeOffsets([c0], 0, t34)).toEqual([5]);
  });
});
