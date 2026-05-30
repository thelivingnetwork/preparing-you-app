# Preparing You — Voiced Presentation Build

Builds the ~5-minute **narrated** video ("Hey Its Brad" ElevenLabs voice) from
the finished slide deck.

## Contents
- `slides/01.png … 27.png` — the finished 1280×720 deck
- `narration.txt` — the voice-over script (per slide)
- `narration.srt` — subtitles, timed to the deck
- `timing.json` — slide order + per-slide fallback durations + narration text
- `build_video.sh` — ElevenLabs TTS + ffmpeg → `Preparing-You-narrated.mp4`

## To produce the voiced MP4
Requires: outbound internet (so `api.elevenlabs.io` is reachable), `ffmpeg`,
`python3`, `curl`, and the ElevenLabs API key in `ELEVENLABS_API_KEY`.
The **"Hey Its Brad"** voice must be saved in that key's account → *My Voices*
(the script finds it by name).

```bash
export ELEVENLABS_API_KEY=sk_...
cd presentation && ./build_video.sh      # -> Preparing-You-narrated.mp4
```

### Running inside a Claude Code web session
If this environment's network policy allows outbound internet and
`ELEVENLABS_API_KEY` is set as a secret, the assistant can run the build here:
1. Install ffmpeg (`apt-get install -y ffmpeg`, or fetch a static build).
2. `cd presentation && ./build_video.sh`
3. Deliver `Preparing-You-narrated.mp4`.

The slides are deterministic; to regenerate them from the app, see the
git history for the generator scripts (or ask the assistant to rebuild).
