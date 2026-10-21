#!/usr/bin/env bash
# Renders a cast from script/record-demo.sh as the README's narrated, highlighted 1920×1080 video:
#   script/render-demo.sh demo.cast [out.mp4]   # needs and settings: docs/maintainers/development.md
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
CAST=$(realpath "$1")
OUT=$(realpath -m "${2:-${CAST%.cast}.mp4}")
NARRATION=${NARRATION:-$ROOT/script/demo-narration.json}
FONT_SIZE=${FONT_SIZE:-20}
WORK=$(mktemp -d)
trap '[ "${KEEP:-}" = 1 ] && echo "kept $WORK" || rm -rf "$WORK"' EXIT

for tool in agg ffmpeg ffprobe node uv; do command -v "$tool" >/dev/null || { echo "$tool is needed to render the demo"; exit 1; }; done

node "$ROOT/script/demo-timeline.mjs" cast "$CAST" "$WORK/timeline.cast" "$NARRATION" "$WORK/timeline.json"
uv run --quiet "$ROOT/script/demo-voice.py" "$NARRATION" "$WORK/voice"
mapfile -t plan < <(node "$ROOT/script/demo-timeline.mjs" plan "$WORK/timeline.json" "$WORK/voice/voice.json" "$FONT_SIZE" "$WORK/focus.txt")
[ "${#plan[@]}" -gt 0 ] || { echo "no plan for the scenes; see the error above"; exit 1; }

echo "drawing the terminal"
agg --idle-time-limit 9999 --last-frame-duration 0 --font-size "$FONT_SIZE" "$WORK/timeline.cast" "$WORK/terminal.gif" >/dev/null 2>&1
ffmpeg -loglevel error -y -i "$WORK/terminal.gif" -r 30 -pix_fmt yuv420p -vf "pad=ceil(iw/2)*2:ceil(ih/2)*2" "$WORK/terminal.mp4"

: >"$WORK/scenes.txt"
for i in "${!plan[@]}"; do
  read -r start length total lead <<<"${plan[i]}"
  held=$(awk -v l="$length" -v t="$total" 'BEGIN { print t - l }')
  ffmpeg -loglevel error -y -ss "$start" -t "$length" -i "$WORK/terminal.mp4" -i "$WORK/voice/$i.wav" \
    -filter_complex "[0:v]tpad=stop_mode=clone:stop_duration=$held[v];[1:a]adelay=$(awk -v l="$lead" 'BEGIN { print l * 1000 }'):all=1,apad,aresample=48000[a]" \
    -map '[v]' -map '[a]' -t "$total" -r 30 -c:v libx264 -crf 12 -pix_fmt yuv420p -c:a aac -ar 48000 -ac 2 "$WORK/scene-$i.mp4"
  echo "file '$WORK/scene-$i.mp4'" >>"$WORK/scenes.txt"
  printf '  scene %d: %.1f s of screen, %.1f s in the video\n' "$i" "$length" "$total"
done
ffmpeg -loglevel error -y -f concat -safe 0 -i "$WORK/scenes.txt" -c copy "$WORK/narrated.mp4"
echo "highlighting"
ffmpeg -loglevel error -y -i "$WORK/narrated.mp4" -filter_script:v "$WORK/focus.txt" \
  -c:v libx264 -preset veryfast -crf 18 -c:a copy -movflags faststart "$OUT"
echo "wrote $OUT ($(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT" | cut -d. -f1) s)"
