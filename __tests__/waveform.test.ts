/**
 * Pure-function tests for the shared waveform module.
 *
 * `drawWaveform` needs a real canvas + window.devicePixelRatio so it's
 * exercised via the integration of WaveformView in the audio-texture +
 * recorder plugins. `computePeaks` is pure math and easy to test in
 * isolation.
 */

import { computePeaks } from '../src/shared/waveform';

/**
 * Build a fake AudioBuffer-like object that satisfies the `length`,
 * `numberOfChannels`, `sampleRate`, and `getChannelData` surface that
 * `computePeaks` actually reads.
 */
function makeBuffer(channels: Float32Array[], sampleRate = 48000): AudioBuffer {
  return {
    length: channels[0].length,
    numberOfChannels: channels.length,
    sampleRate,
    getChannelData: (i: number) => channels[i],
    duration: channels[0].length / sampleRate,
    copyFromChannel: () => undefined,
    copyToChannel: () => undefined,
  } as unknown as AudioBuffer;
}

describe('computePeaks', () => {
  it('produces (bins × 2) min/max pairs', () => {
    const samples = new Float32Array(1024);
    const buffer = makeBuffer([samples]);
    const result = computePeaks(buffer, 64);

    expect(result.peaks).toHaveLength(64 * 2);
    expect(result.totalSamples).toBe(1024);
    expect(result.sampleRate).toBe(48000);
  });

  it('returns 0/0 for an all-silence buffer', () => {
    const samples = new Float32Array(1024); // zero-filled
    const buffer = makeBuffer([samples]);
    const result = computePeaks(buffer, 32);

    for (let i = 0; i < result.peaks.length; i++) {
      expect(result.peaks[i]).toBe(0);
    }
  });

  it('captures min and max within each bin for an alternating buffer', () => {
    const samples = new Float32Array(512);
    // Alternate every sample so any bin >= 2 samples sees both polarities.
    for (let i = 0; i < samples.length; i++) {
      samples[i] = (i % 2 === 0 ? 1 : -1) * 0.8;
    }
    const buffer = makeBuffer([samples]);
    const result = computePeaks(buffer, 16);

    // Each bin spans 32 samples → contains both +0.8 and -0.8.
    for (let i = 0; i < 16; i++) {
      const mn = result.peaks[i * 2];
      const mx = result.peaks[i * 2 + 1];
      expect(mx).toBeGreaterThan(0.7);
      expect(mn).toBeLessThan(-0.7);
    }
  });

  it('averages stereo channels into a single waveform', () => {
    const left = new Float32Array(512);
    const right = new Float32Array(512);
    for (let i = 0; i < 512; i++) {
      left[i] = 1;
      right[i] = -1;
    }
    const buffer = makeBuffer([left, right]);
    const result = computePeaks(buffer, 8);

    // Average of +1 and -1 is 0 — peaks should be flat.
    for (let i = 0; i < result.peaks.length; i++) {
      expect(Math.abs(result.peaks[i])).toBeLessThan(1e-6);
    }
  });

  it('handles bins greater than buffer length without throwing', () => {
    const samples = new Float32Array(8);
    samples[0] = 0.5;
    samples[7] = -0.5;
    const buffer = makeBuffer([samples]);
    const result = computePeaks(buffer, 64);

    expect(result.peaks).toHaveLength(128);
    // First bin should at minimum capture the 0.5 sample.
    const firstMax = result.peaks[1];
    expect(firstMax).toBeGreaterThanOrEqual(0.5);
  });

  it('substitutes 0 for empty bins (no Infinity leakage)', () => {
    // A short buffer where bin >= length will have an empty slice.
    const samples = new Float32Array(4);
    samples.fill(0.25);
    const buffer = makeBuffer([samples]);
    const result = computePeaks(buffer, 16);

    for (let i = 0; i < result.peaks.length; i++) {
      expect(Number.isFinite(result.peaks[i])).toBe(true);
    }
  });
});
