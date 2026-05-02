# sas-recorder

A [Signals & Sorcery](https://signalsandsorcery.com) plugin for loop-aware microphone recording.

Each iteration of the active loop produces a new muted audio track, so you can build up
vocal layers non-destructively over a playing loop. Recorded tracks support the full
FX chain (compressor / EQ / reverb / delay), include three baked vocal presets, and
ship with a one-shot mic-latency calibration probe.

## Status

Built against `@signalsandsorcery/plugin-sdk` ≥ 2.1.0. The SDK 2.1.0 release added the
`audioCapture` capability and the `getAudioInputDevices` / `startTrackRecording` /
`markRecordingChunkBoundary` / `stopTrackRecording` / `onRecordingChunkFinalized`
host methods this plugin depends on.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  RecorderPanel                                               │
│  ─ Record/Stop button + input device picker                  │
│  ─ Vocal preset chooser + Calibrate button                   │
│  ─ List of takes; each take shows a waveform + delete        │
└──────────────────────────────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────────┐
│  useRecorder (state machine)                                 │
│  ─ idle ──Record──► arming ──onDeckBoundary──► recording     │
│  ─ recording ──onDeckBoundary──► markRecordingChunkBoundary  │
│  ─ recording ──Stop──► stopping ──stopTrackRecording──► idle │
└──────────────────────────────────────────────────────────────┘
                       │
                       ▼
              host.startTrackRecording / markRecordingChunkBoundary /
              stopTrackRecording — driven by onDeckBoundary so each
              loop iteration finalizes a chunk.

              onRecordingChunkFinalized → host.createTrack +
              writeAudioClip + setTrackMute(true) + applyVocalPreset.
```

## File layout

```
sas-recorder/
├── src/
│   ├── index.ts                  # RecorderPlugin class
│   ├── RecorderPanel.tsx         # Top-level UI
│   ├── useRecorder.ts            # State machine hook
│   ├── vocalPresets.ts           # Bright / Dark / Spoken-Word presets
│   ├── alignmentCalibration.ts   # Click-and-listen latency probe
│   └── shared/
│       ├── waveform.ts           # computePeaks + drawWaveform
│       └── WaveformView.tsx      # Per-take waveform component
├── plugin.json                   # Manifest (audioCapture capability)
└── __tests__/                    # Hook + preset + waveform unit tests
```

## Development

```bash
npm install
npm run typecheck
npm test
npm run build      # tsup → dist/index.{js,mjs,d.ts}
```

## Companion in-tree copy

The canonical, working source for this plugin is currently mirrored in-tree under
`sas-assistant/src/plugins/builtin/recorder/`. That copy is what the assistant
actually loads via the built-in plugin registry. This standalone repo is the
distributable form — once the assistant migrates to consuming this package via
`file:../sas-recorder`, the in-tree copy can be removed.
