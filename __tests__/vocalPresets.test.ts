/**
 * Vocal preset applier tests — verify that switching presets enables
 * the right categories, disables the others, and writes dryWet when
 * specified.
 */

import type { PluginHost, FxCategory } from '@signalsandsorcery/plugin-sdk';
import {
  VOCAL_PRESETS,
  applyVocalPreset,
  applyVocalPresetToTracks,
} from '../src/vocalPresets';

interface MockHostState {
  /** Map of category → final enabled state. */
  toggles: Record<string, boolean>;
  /** Map of category → preset index. */
  presets: Record<string, number>;
  /** Map of category → dry/wet value. */
  dryWets: Record<string, number>;
  /** Track IDs that should fail with this error message. */
  failingTracks: Map<string, string>;
}

function createMockHost(): { host: PluginHost; state: MockHostState } {
  const state: MockHostState = {
    toggles: {},
    presets: {},
    dryWets: {},
    failingTracks: new Map(),
  };
  const host = {
    setTrackFxPreset: jest.fn(async (trackId: string, category: FxCategory, idx: number) => {
      const failure = state.failingTracks.get(trackId);
      if (failure) throw new Error(failure);
      state.presets[`${trackId}:${category}`] = idx;
    }),
    toggleTrackFx: jest.fn(async (trackId: string, category: FxCategory, enabled: boolean) => {
      const failure = state.failingTracks.get(trackId);
      if (failure) throw new Error(failure);
      state.toggles[`${trackId}:${category}`] = enabled;
    }),
    setTrackFxDryWet: jest.fn(async (trackId: string, category: FxCategory, value: number) => {
      const failure = state.failingTracks.get(trackId);
      if (failure) throw new Error(failure);
      state.dryWets[`${trackId}:${category}`] = value;
    }),
  } as unknown as PluginHost;
  return { host, state };
}

describe('applyVocalPreset', () => {
  it('enables only the categories present in the preset and disables the rest', async () => {
    const { host, state } = createMockHost();
    const bright = VOCAL_PRESETS.find((p) => p.id === 'bright')!;

    await applyVocalPreset(host, 'track-1', bright);

    // Categories the "bright" preset declares — should all be enabled.
    expect(state.toggles['track-1:eq']).toBe(true);
    expect(state.toggles['track-1:compressor']).toBe(true);
    expect(state.toggles['track-1:reverb']).toBe(true);

    // Categories NOT in the preset — should be explicitly disabled to
    // clean up state from any previously-applied preset.
    expect(state.toggles['track-1:delay']).toBe(false);
    expect(state.toggles['track-1:chorus']).toBe(false);
    expect(state.toggles['track-1:phaser']).toBe(false);
  });

  it('writes dryWet when the preset specifies it', async () => {
    const { host, state } = createMockHost();
    const bright = VOCAL_PRESETS.find((p) => p.id === 'bright')!;

    await applyVocalPreset(host, 'track-1', bright);

    // Bright preset: reverb dryWet = 0.25.
    expect(state.dryWets['track-1:reverb']).toBe(0.25);
    // EQ + compressor have no dryWet override — entries absent.
    expect(state.dryWets['track-1:eq']).toBeUndefined();
  });

  it('"none" preset disables every FX category on the track', async () => {
    const { host, state } = createMockHost();
    const none = VOCAL_PRESETS.find((p) => p.id === 'none')!;

    await applyVocalPreset(host, 'track-1', none);

    expect(state.toggles['track-1:eq']).toBe(false);
    expect(state.toggles['track-1:compressor']).toBe(false);
    expect(state.toggles['track-1:reverb']).toBe(false);
    expect(state.toggles['track-1:delay']).toBe(false);
    expect(state.toggles['track-1:chorus']).toBe(false);
    expect(state.toggles['track-1:phaser']).toBe(false);
  });

  it('preset indices match the declarations in VOCAL_PRESETS', async () => {
    const { host, state } = createMockHost();
    const dark = VOCAL_PRESETS.find((p) => p.id === 'dark')!;

    await applyVocalPreset(host, 'track-1', dark);

    expect(state.presets['track-1:eq']).toBe(2);
    expect(state.presets['track-1:compressor']).toBe(1);
    expect(state.presets['track-1:delay']).toBe(0);
  });
});

describe('applyVocalPresetToTracks', () => {
  it('returns ok IDs for successful tracks and failed entries for errored ones', async () => {
    const { host, state } = createMockHost();
    state.failingTracks.set('track-3', 'engine offline');

    const dark = VOCAL_PRESETS.find((p) => p.id === 'dark')!;
    const result = await applyVocalPresetToTracks(host, ['track-1', 'track-2', 'track-3'], dark);

    expect(result.ok).toEqual(['track-1', 'track-2']);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].trackId).toBe('track-3');
    expect(result.failed[0].error).toBe('engine offline');
  });

  it('continues processing remaining tracks after one fails', async () => {
    const { host, state } = createMockHost();
    state.failingTracks.set('track-1', 'first track gone');

    const spoken = VOCAL_PRESETS.find((p) => p.id === 'spoken')!;
    await applyVocalPresetToTracks(host, ['track-1', 'track-2'], spoken);

    // Track 2 should still have the spoken preset applied.
    expect(state.toggles['track-2:eq']).toBe(true);
    expect(state.toggles['track-2:compressor']).toBe(true);
  });
});
