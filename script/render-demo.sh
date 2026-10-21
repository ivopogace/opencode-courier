#!/usr/bin/env bash
# Renders a cast from script/record-demo.sh as the README's narrated video: the terminal drawn by agg at 1920×1080, and
# each scene's line of script/demo-narration.json spoken by script/demo-voice.py (Kokoro-82M from Hugging Face) from the
# scene's start, its last frame held while the voice runs on (docs/maintainers/development.md).
#
#   script/render-demo.sh demo.cast [out.mp4]   # default: the cast's name with .mp4; KEEP=1 keeps the temp dir
#
# Needs agg, ffmpeg, node and uv. IDLE (3 s) caps each pause of the cast; FONT_SIZE (20) is agg's.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
CAST=$(realpath "$1")
OUT=$(realpath -m "${2:-${CAST%.cast}.mp4}")
NARRATION=${NARRATION:-$ROOT/script/demo-narration.json}
WORK=$(mktemp -d)
# The voice starts this long into its scene, and the scene runs at least this long past it.
LEAD=0.4
TAIL=0.8
trap '[ "${KEEP:-}" = 1 ] && echo "kept $WORK" || rm -rf "$WORK"' EXIT

for tool in agg ffmpeg node uv; do command -v "$tool" >/dev/null || { echo "$tool is needed to render the demo"; exit 1; }; done

mapfile -t bounds < <(node "$ROOT/script/demo-timeline.mjs" "$CAST" "$WORK/timeline.cast" "$NARRATION")
echo "speaking $((${#bounds[@]} - 1)) scenes"
uv run --quiet "$ROOT/script/demo-voice.py" "$NARRATION" "$WORK/voice"
mapfile -t seconds < <(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).seconds.join("\n")' "$WORK/voice/voice.json")

echo "drawing the terminal"
agg --idle-time-limit 9999 --last-frame-duration 0 --font-size "${FONT_SIZE:-20}" "$WORK/timeline.cast" "$WORK/terminal.gif" >/dev/null 2>&1
ffmpeg -loglevel error -y -i "$WORK/terminal.gif" -r 30 -pix_fmt yuv420p \
  -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2" "$WORK/terminal.mp4"

: >"$WORK/scenes.txt"
for ((i = 0; i < ${#bounds[@]} - 1; i++)); do
  start=${bounds[i]}
  length=$(awk -v a="$start" -v b="${bounds[i + 1]}" 'BEGIN { print b - a }')
  total=$(awk -v l="$length" -v s="${seconds[i]}" -v lead="$LEAD" -v tail="$TAIL" 'BEGIN { n = s + lead + tail; print (n > l ? n : l) }')
  held=$(awk -v l="$length" -v t="$total" 'BEGIN { print t - l }')
  ffmpeg -loglevel error -y -ss "$start" -t "$length" -i "$WORK/terminal.mp4" -i "$WORK/voice/$i.wav" \
    -filter_complex "[0:v]tpad=stop_mode=clone:stop_duration=$held[v];[1:a]adelay=$(awk -v l="$LEAD" 'BEGIN { print l * 1000 }'):all=1,apad,aresample=48000[a]" \
    -map '[v]' -map '[a]' -t "$total" -r 30 -c:v libx264 -pix_fmt yuv420p -c:a aac -ar 48000 -ac 2 "$WORK/scene-$i.mp4"
  echo "file '$WORK/scene-$i.mp4'" >>"$WORK/scenes.txt"
  printf '  scene %d: %.1f s of screen, %.1f s of voice\n' "$i" "$length" "${seconds[i]}"
done
ffmpeg -loglevel error -y -f concat -safe 0 -i "$WORK/scenes.txt" -c copy -movflags faststart "$OUT"
echo "wrote $OUT ($(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT" | cut -d. -f1) s)"
