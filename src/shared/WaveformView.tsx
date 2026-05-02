/**
 * WaveformView — small canvas waveform for an audio file on disk.
 *
 * Reads bytes via `host.getAudioFileBytes`, decodes via
 * `AudioContext.decodeAudioData`, computes peaks, and renders to a
 * canvas. Suitable for take rows, sample previews, or any place a
 * decorative ~40px waveform makes sense.
 *
 * The component is self-contained: it owns the AudioContext and the
 * peak buffer, decodes once per `filePath` change, and tears down on
 * unmount. Failures (file missing, decode error) render as a silent
 * blank canvas — the caller can decide how to surface errors.
 */

import React, { useEffect, useRef, useState } from 'react';
import type { PluginHost } from '@signalsandsorcery/plugin-sdk';
import { computePeaks, drawWaveform, type WaveformPeaks } from './waveform';

export interface WaveformViewProps {
  host: PluginHost;
  filePath: string;
  /** Number of bins to compute. Default 256 — plenty for ~40px tall rows. */
  bins?: number;
  /** Tailwind / inline className for sizing. Default: w-full h-10. */
  className?: string;
  /** Override the bar fill style (e.g., to match a track color). */
  fillStyle?: string;
}

export const WaveformView: React.FC<WaveformViewProps> = ({
  host,
  filePath,
  bins = 256,
  className,
  fillStyle,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [peaks, setPeaks] = useState<WaveformPeaks | null>(null);

  // Decode + compute peaks whenever the file changes.
  useEffect(() => {
    let cancelled = false;
    let audioContext: AudioContext | null = null;

    (async () => {
      try {
        const bytes = await host.getAudioFileBytes(filePath);
        if (cancelled) return;

        // OfflineAudioContext would be cheaper but its constructor needs
        // sampleRate/length up front — we don't know them until decode.
        const ContextCtor: typeof AudioContext =
          (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext!;
        audioContext = new ContextCtor();

        // decodeAudioData mutates / detaches the buffer in some impls,
        // so pass a copy.
        const audioBuffer = await audioContext.decodeAudioData(bytes.slice(0));
        if (cancelled) return;

        const computed = computePeaks(audioBuffer, bins);
        setPeaks(computed);
      } catch (err) {
        // Silent: the canvas stays blank. Caller can layer their own
        // error UI on top if needed.
        console.warn('[WaveformView] failed to decode', filePath, err);
      } finally {
        if (audioContext) {
          audioContext.close().catch(() => { /* ignore */ });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [host, filePath, bins]);

  // Repaint whenever peaks update — including layout-driven resizes via
  // ResizeObserver so the canvas stays crisp at the current CSS width.
  useEffect(() => {
    if (!peaks) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    drawWaveform(canvas, peaks, fillStyle ? { fillStyle } : undefined);

    const observer = new ResizeObserver(() => {
      drawWaveform(canvas, peaks, fillStyle ? { fillStyle } : undefined);
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [peaks, fillStyle]);

  return (
    <canvas
      ref={canvasRef}
      data-testid="waveform-view"
      className={className ?? 'w-full h-10'}
    />
  );
};

export default WaveformView;
