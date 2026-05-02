/**
 * @signalsandsorcery/recorder — Built-in Recorder Plugin
 *
 * Loop-aware microphone recording. Each iteration of the active loop
 * produces a new muted audio track. Drives a state machine that:
 *   - arms on Record click while the transport is playing,
 *   - chunks at every `onDeckBoundary` event,
 *   - finalizes each chunk into a new audio track via `host.writeAudioClip`,
 *   - mutes each take by default so it does not bleed into the next loop.
 *
 * Engine recording RPCs (`startTrackRecording` / `stopTrackRecording` /
 * `markRecordingChunkBoundary`) are implemented in the C++ engine
 * (Phase 1) and bridged through the TS Tracktion bridge (Phase 2).
 */

import type { ComponentType } from 'react';
import type {
  GeneratorPlugin,
  PluginHost,
  PluginUIProps,
  PluginSettingsSchema,
} from '@signalsandsorcery/plugin-sdk';
import { RecorderPanel } from './RecorderPanel';

export class RecorderPlugin implements GeneratorPlugin {
  readonly id = '@signalsandsorcery/recorder';
  readonly displayName = 'Recorder';
  readonly version = '1.0.0';
  readonly description = 'Loop-aware microphone recording — each loop creates a muted take';
  readonly generatorType = 'audio' as const;
  readonly minHostVersion = '2.1.0';

  private host: PluginHost | null = null;

  async activate(host: PluginHost): Promise<void> {
    this.host = host;
    console.log('[RecorderPlugin] Activated');
  }

  async deactivate(): Promise<void> {
    // RecorderPanel's useRecorder hook handles its own cleanup via React
    // useEffect teardown when the component unmounts. The host releases
    // its event subscriptions via _cleanup on project switch.
    this.host = null;
    console.log('[RecorderPlugin] Deactivated');
  }

  getUIComponent(): ComponentType<PluginUIProps> {
    return RecorderPanel;
  }

  getSettingsSchema(): PluginSettingsSchema | null {
    return null;
  }
}

export default RecorderPlugin;
