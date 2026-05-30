#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════
# Preparing You — build the NARRATED MP4 (ElevenLabs voice + ffmpeg).
#
# Each slide is shown for exactly as long as its narration takes to speak,
# producing a ~5-minute voiced presentation.
#
# REQUIREMENTS (on a machine with internet):
#   • ffmpeg        — brew install ffmpeg   |   apt-get install ffmpeg
#   • curl, python3 (standard)
#   • Your ElevenLabs API key:   export ELEVENLABS_API_KEY=sk_...
#
# VOICE: set below (the "Higher Liberty" narration voice).
#
# USAGE:
#   export ELEVENLABS_API_KEY=sk_xxx
#   cd kit && ./build_video.sh
#   -> Preparing-You-narrated.mp4
#
# To re-use audio without re-spending credits, delete audio/*.mp3 to regenerate;
# otherwise existing audio/NN.mp3 files are reused as-is.
# ════════════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")"

# ── Voice configuration ─────────────────────────────────────────────
# You can either set a Voice ID directly, OR let the script find the voice by
# name (default). The "Hey Its Brad" voice must be saved in your ElevenLabs
# "My Voices" for name lookup to work (if it's a Library voice, click "Add"
# to add it to your account first).
VOICE_NAME="${ELEVENLABS_VOICE_NAME:-Hey Its Brad}"
VOICE_ID="${ELEVENLABS_VOICE_ID:-}"                        # optional override
MODEL_ID="${ELEVENLABS_MODEL_ID:-eleven_multilingual_v2}"
STABILITY="${ELEVENLABS_STABILITY:-0.45}"
SIMILARITY="${ELEVENLABS_SIMILARITY:-0.80}"
STYLE="${ELEVENLABS_STYLE:-0.0}"
# ────────────────────────────────────────────────────────────────────

SLIDES_DIR="slides"; AUDIO_DIR="audio"; WORK="work"; OUT="Preparing-You-narrated.mp4"
mkdir -p "$AUDIO_DIR" "$WORK"
command -v ffmpeg >/dev/null || { echo "ffmpeg not found — install it first."; exit 1; }
: "${ELEVENLABS_API_KEY:?Set ELEVENLABS_API_KEY first (export ELEVENLABS_API_KEY=sk_...)}"

# Resolve the Voice ID from the voice name if not given explicitly.
if [ -z "$VOICE_ID" ]; then
  echo "Looking up voice \"$VOICE_NAME\" in your ElevenLabs account…"
  curl -sS -H "xi-api-key: $ELEVENLABS_API_KEY" https://api.elevenlabs.io/v1/voices > "$WORK/voices.json"
  VOICE_ID=$(python3 - "$VOICE_NAME" "$WORK/voices.json" <<'PY'
import json,sys
name=sys.argv[1].lower()
d=json.load(open(sys.argv[2]))
voices=d.get("voices",[])
m=[v for v in voices if name in v.get("name","").lower()]
if not m:
    sys.stderr.write("No voice matching '%s'. Voices in your account:\n%s\n"
        % (sys.argv[1], "\n".join("  - "+v.get("name","?") for v in voices)))
    sys.exit(2)
print(m[0]["voice_id"])
PY
) || { echo ">> '$VOICE_NAME' isn't in your My Voices yet. In ElevenLabs, open the voice and click 'Add to My Voices', then re-run."; exit 1; }
  echo "Using voice: $VOICE_NAME  ($VOICE_ID)"
fi

COUNT=$(python3 -c "import json;print(len(json.load(open('timing.json'))))")
get(){ python3 - "$1" "$2" <<'PY'
import json,sys; d=json.load(open("timing.json")); print(d[int(sys.argv[1])][sys.argv[2]])
PY
}

CONCAT="$WORK/v.txt"; : > "$CONCAT"
ACONCAT="$WORK/a.txt"; : > "$ACONCAT"

for i in $(seq 0 $((COUNT-1))); do
  n=$(get "$i" n); sec=$(get "$i" sec); text=$(get "$i" t)
  png="$SLIDES_DIR/$n.png"; mp3="$AUDIO_DIR/$n.mp3"; wav="$WORK/$n.wav"

  # 1) ElevenLabs TTS (skip if audio already present)
  if [ ! -f "$mp3" ]; then
    echo "  synth slide $n …"
    body=$(python3 - "$text" <<PY
import json,sys
print(json.dumps({
  "text": sys.argv[1],
  "model_id": "$MODEL_ID",
  "voice_settings": {"stability": $STABILITY, "similarity_boost": $SIMILARITY, "style": $STYLE, "use_speaker_boost": True}
}))
PY
)
    curl -sS -X POST "https://api.elevenlabs.io/v1/text-to-speech/$VOICE_ID" \
      -H "xi-api-key: $ELEVENLABS_API_KEY" -H "Content-Type: application/json" \
      -H "Accept: audio/mpeg" -d "$body" -o "$mp3"
    # guard against an error JSON saved as .mp3
    if head -c1 "$mp3" | grep -q '{'; then echo "ElevenLabs error on slide $n:"; cat "$mp3"; exit 1; fi
  fi

  ffmpeg -y -loglevel error -i "$mp3" "$wav"
  alen=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$wav")
  dur=$(python3 -c "print(round(max($alen,$sec)+0.7,2))")
  ffmpeg -y -loglevel error -i "$wav" -af "apad" -t "$dur" "$WORK/a-$n.wav"
  ffmpeg -y -loglevel error -loop 1 -i "$png" -t "$dur" -r 30 -vf "scale=1280:720,format=yuv420p" "$WORK/v-$n.mp4"
  echo "file '$(pwd)/$WORK/v-$n.mp4'"  >> "$CONCAT"
  echo "file '$(pwd)/$WORK/a-$n.wav'" >> "$ACONCAT"
  echo "  slide $n -> ${dur}s"
done

ffmpeg -y -loglevel error -f concat -safe 0 -i "$CONCAT" -c copy "$WORK/video.mp4"
ffmpeg -y -loglevel error -f concat -safe 0 -i "$ACONCAT" "$WORK/audio.wav"
ffmpeg -y -loglevel error -i "$WORK/video.mp4" -i "$WORK/audio.wav" \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -b:a 192k -shortest "$OUT"
echo "Done -> $OUT"
