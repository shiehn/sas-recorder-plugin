/**
 * Vocal FX preset chooser data + applier.
 *
 * Three baked vocal presets that map to the existing track-FX surface
 * (eq / compressor / reverb / delay / chorus / phaser). Each preset is
 * a small bundle of `host.toggleTrackFx` + `host.setTrackFxPreset` +
 * (optional) `host.setTrackFxDryWet` calls.
 *
 * The preset indices reference the engine's built-in FX preset banks
 * (see `FX_PRESET_CONFIGS` in `fx-presets.ts`); category index 0 is the
 * first preset, 1 is the second, etc. We intentionally pick safe,
 * vocal-friendly defaults rather than hyped settings — the user can
 * tweak post-recording.
 */

import type { PluginHost, FxCategory } from '@signalsandsorcery/plugin-sdk';

export type VocalPresetId = 'none' | 'bright' | 'dark' | 'spoken';

interface PresetCategoryEntry {
  enabled: boolean;
  presetIndex: number;
  /** Optional dry/wet override (0..1). Omit to keep the preset's default. */
  dryWet?: number;
}

export interface VocalPreset {
  id: VocalPresetId;
  label: string;
  description: string;
  /** Per-category configuration. Missing categories stay disabled. */
  categories: Partial<Record<FxCategory, PresetCategoryEntry>>;
}

export const VOCAL_PRESETS: readonly VocalPreset[] = [
  {
    id: 'none',
    label: 'No FX',
    description: 'Dry signal — no processing.',
    categories: {},
  },
  {
    id: 'bright',
    label: 'Bright',
    description: 'Presence boost, gentle compression, small room reverb.',
    categories: {
      eq: { enabled: true, presetIndex: 1 },
      compressor: { enabled: true, presetIndex: 0 },
      reverb: { enabled: true, presetIndex: 0, dryWet: 0.25 },
    },
  },
  {
    id: 'dark',
    label: 'Dark / Crooner',
    description: 'Low-mid emphasis, heavier compression, dotted-eighth delay.',
    categories: {
      eq: { enabled: true, presetIndex: 2 },
      compressor: { enabled: true, presetIndex: 1 },
      delay: { enabled: true, presetIndex: 0, dryWet: 0.15 },
    },
  },
  {
    id: 'spoken',
    label: 'Spoken Word',
    description: 'High-pass + light compression. No reverb / delay.',
    categories: {
      eq: { enabled: true, presetIndex: 0 },
      compressor: { enabled: true, presetIndex: 0 },
    },
  },
];

const ALL_FX_CATEGORIES: readonly FxCategory[] = [
  'eq',
  'compressor',
  'chorus',
  'phaser',
  'delay',
  'reverb',
];

/**
 * Apply a vocal preset to a single track via the host's FX surface.
 * Disables every category not mentioned by the preset so switching from
 * "Dark" → "Spoken Word" doesn't leave the previous preset's reverb on.
 */
export async function applyVocalPreset(
  host: PluginHost,
  trackId: string,
  preset: VocalPreset
): Promise<void> {
  for (const category of ALL_FX_CATEGORIES) {
    const cfg = preset.categories[category];
    if (cfg && cfg.enabled) {
      await host.setTrackFxPreset(trackId, category, cfg.presetIndex);
      await host.toggleTrackFx(trackId, category, true);
      if (cfg.dryWet !== undefined) {
        await host.setTrackFxDryWet(trackId, category, cfg.dryWet);
      }
    } else {
      await host.toggleTrackFx(trackId, category, false);
    }
  }
}

/**
 * Apply the same vocal preset to many tracks. Each track is processed
 * sequentially to avoid IPC contention. Errors on individual tracks are
 * collected and returned rather than thrown — the caller decides what
 * to do with partial success.
 */
export async function applyVocalPresetToTracks(
  host: PluginHost,
  trackIds: readonly string[],
  preset: VocalPreset
): Promise<{ ok: string[]; failed: Array<{ trackId: string; error: string }> }> {
  const ok: string[] = [];
  const failed: Array<{ trackId: string; error: string }> = [];
  for (const trackId of trackIds) {
    try {
      await applyVocalPreset(host, trackId, preset);
      ok.push(trackId);
    } catch (err: unknown) {
      failed.push({
        trackId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { ok, failed };
}
