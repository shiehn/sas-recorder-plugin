# Recorder Plugin

A [Signals & Sorcery](https://signalsandsorcery.com) plugin for loop-aware microphone recording. Each iteration of the active loop produces a new muted audio track, so you can build up vocal layers non-destructively over a playing loop.

<p align="center">
  <img src="assets/ribbon-microphone.png" alt="Signals & Sorcery — Recorder" width="420" />
</p>

> Part of the **[Signals & Sorcery](https://signalsandsorcery.com)** ecosystem.

## What it does

- **Loop-aware tracking** — each iteration of the active loop finalizes into its own muted audio track, so layered vocal takes never bleed into the next pass
- **Vocal presets** — three baked FX chains (Bright, Dark, Spoken-Word) applied automatically to each take
- **One-shot mic-latency calibration** — click-and-listen probe stores a recording offset so takes line up with the grid
- **Per-take waveform + delete** — every take renders an inline waveform and can be removed without touching the rest of the layer stack
- **Live input meter + auto-set gain** — peak indicator and a one-click probe that sets recording gain to land peaks at -6 dBFS

## Install

From within Signals & Sorcery: **Settings > Manage Plugins > Add Plugin** and enter:

```
https://github.com/shiehn/sas-recorder-plugin
```

Or clone manually into `~/.signals-and-sorcery/plugins/@signalsandsorcery/recorder/`.

## Capabilities

| Capability | Required |
|------------|----------|
| `audioCapture` | Yes — microphone input + loop-boundary chunked recording |

Built against `@signalsandsorcery/plugin-sdk` ≥ 2.1.0. SDK 2.1.0 added the `audioCapture` capability and the `getAudioInputDevices` / `startTrackRecording` / `markRecordingChunkBoundary` / `stopTrackRecording` / `onRecordingChunkFinalized` host methods this plugin depends on.

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

## Development

Built with the [@signalsandsorcery/plugin-sdk](https://github.com/shiehn/sas-plugin-sdk). See the [Plugin SDK docs](https://signalsandsorcery.com/plugin-sdk/) for the full API reference.

```bash
npm install
npm run typecheck
npm test
npm run build      # tsup → dist/index.{js,mjs,d.ts}
```

## The Signals & Sorcery Ecosystem

- **[Signals & Sorcery](https://signalsandsorcery.com)** — the flagship AI music production workstation
- **[sas-plugin-sdk](https://github.com/shiehn/sas-plugin-sdk)** — TypeScript SDK for building generator plugins
- **[sas-synth-plugin](https://github.com/shiehn/sas-synth-plugin)** — AI MIDI generation with Surge XT
- **[sas-sample-plugin](https://github.com/shiehn/sas-sample-plugin)** — Sample library browser with time-stretching
- **[sas-audio-plugin](https://github.com/shiehn/sas-audio-plugin)** — AI audio texture generation
- **[sas-chat-plugin](https://github.com/shiehn/sas-chat-plugin)** — Natural-language scene assistant
- **[DeclarAgent](https://github.com/shiehn/DeclarAgent)** — Declarative agent + MCP transport for S&S

<p align="center">
  <a href="https://signalsandsorcery.com">signalsandsorcery.com</a>
</p>

## License

MIT
