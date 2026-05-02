/**
 * Shared waveform peaks + canvas drawer.
 *
 * Originally inlined in `audio-texture/TrimEditorDrawer.tsx`; lifted to
 * this module so the recorder plugin's per-take rows can render the
 * same compact min/max display without duplicating the math.
 *
 * Design:
 *   - `computePeaks` reduces an AudioBuffer to `bins` min/max pairs (mono
 *     average across channels). Output layout is interleaved
 *     `[min0, max0, min1, max1, ...]` so the renderer reads pairs
 *     sequentially without index arithmetic.
 *   - `drawWaveform` paints one 1px vertical bar per canvas column,
 *     dpr-aware so it stays crisp on retina displays.
 *
 * No host or React dependencies — pure functions are safe to use from
 * tests, web workers, or non-React renderers.
 */

export interface WaveformPeaks {
  /** Sample rate of the source file (used to convert sample → seconds). */
  sampleRate: number;
  /** Total length of the raw file in samples. */
  totalSamples: number;
  /** Min/max pairs per bin (length = bins × 2). */
  peaks: Float32Array;
}

/**
 * Reduce an AudioBuffer to `bins` min/max pairs. Mono averages across
 * channels. The output buffer is fixed-size (`bins * 2`) for fast canvas
 * traversal.
 */
export function computePeaks(audioBuffer: AudioBuffer, bins: number): WaveformPeaks {
  const { length, numberOfChannels, sampleRate } = audioBuffer;
  const channels: Float32Array[] = [];
  for (let c = 0; c < numberOfChannels; c++) {
    channels.push(audioBuffer.getChannelData(c));
  }
  const samplesPerBin = Math.max(1, Math.floor(length / bins));
  const out = new Float32Array(bins * 2);
  for (let i = 0; i < bins; i++) {
    const startIdx = i * samplesPerBin;
    const endIdx = Math.min(length, startIdx + samplesPerBin);
    let mn = Infinity;
    let mx = -Infinity;
    for (let j = startIdx; j < endIdx; j++) {
      let v = 0;
      for (let c = 0; c < numberOfChannels; c++) {
        v += channels[c][j];
      }
      v /= numberOfChannels;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    if (!Number.isFinite(mn)) mn = 0;
    if (!Number.isFinite(mx)) mx = 0;
    out[i * 2] = mn;
    out[i * 2 + 1] = mx;
  }
  return { sampleRate, totalSamples: length, peaks: out };
}

/**
 * Draw min/max peaks to the given canvas. Resizes the canvas backing
 * store to CSS pixels × devicePixelRatio so the result is crisp on
 * retina. Caller controls CSS sizing via the `<canvas>` element's
 * className.
 */
export function drawWaveform(
  canvas: HTMLCanvasElement,
  peaks: WaveformPeaks,
  options: { fillStyle?: string } = {}
): void {
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = canvas.clientWidth;
  const cssHeight = canvas.clientHeight;
  if (cssWidth === 0 || cssHeight === 0) return;
  canvas.width = Math.floor(cssWidth * dpr);
  canvas.height = Math.floor(cssHeight * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssWidth, cssHeight);
  ctx.fillStyle = options.fillStyle ?? 'rgba(255, 255, 255, 0.4)';

  const bins = peaks.peaks.length / 2;
  const mid = cssHeight / 2;
  for (let x = 0; x < cssWidth; x++) {
    const binIdx = Math.floor((x / cssWidth) * bins);
    const mn = peaks.peaks[binIdx * 2];
    const mx = peaks.peaks[binIdx * 2 + 1];
    const yTop = mid - mx * mid;
    const yBot = mid - mn * mid;
    ctx.fillRect(x, yTop, 1, Math.max(1, yBot - yTop));
  }
}
