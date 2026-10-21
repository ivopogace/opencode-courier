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
agg --fps-cap "${FPS:-15}" --idle-time-limit 9999 --last-frame-duration 0 --font-size "$FONT_SIZE" "$WORK/timeline.cast" "$WORK/terminal.gif" >/dev/null 2>&1
ffmpeg -loglevel error -y -i "$WORK/terminal.gif" -r 30 -pix_fmt yuv420p -vf "pad=ceil(iw/2)*2:ceil(ih/2)*2" -c:v libx264 -preset veryfast -crf 12 "$WORK/terminal.mp4"

: >"$WORK/scenes.txt"
for i in "${!plan[@]}"; do
  read -r start length total lead <<<"${plan[i]}"
  held=$(awk -v l="$length" -v t="$total" 'BEGIN { print t - l }')
  ffmpeg -loglevel error -y -ss "$start" -t "$length" -i "$WORK/terminal.mp4" -i "$WORK/voice/$i.wav" \
    -filter_complex "[0:v]tpad=stop_mode=clone:stop_duration=$held[v];[1:a]adelay=$(awk -v l="$lead" 'BEGIN { print l * 1000 }'):all=1,apad,aresample=48000[a]" \
    -map '[v]' -map '[a]' -t "$total" -r 30 -c:v libx264 -preset veryfast -crf 12 -pix_fmt yuv420p -c:a aac -ar 48000 -ac 2 "$WORK/scene-$i.mp4"
  echo "file '$WORK/scene-$i.mp4'" >>"$WORK/scenes.txt"
  printf '  scene %d: %.1f s of screen, %.1f s in the video\n' "$i" "$length" "$total"
done
ffmpeg -loglevel error -y -f concat -safe 0 -i "$WORK/scenes.txt" -c copy "$WORK/narrated.mp4"
echo "highlighting"
ffmpeg -loglevel error -y -i "$WORK/narrated.mp4" -filter_script:v "$WORK/focus.txt" \
  -c:v libx264 -preset veryfast -crf 18 -c:a copy "$WORK/highlighted.mp4"

echo "the end card"
outro=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).outro' "$WORK/voice/voice.json")
card=$(awk -v s="$outro" 'BEGIN { print s + 3.5 }')
font=${FONT:-$(fc-match -f '%{file}' 'Inter:style=Bold')}
mono=${MONO_FONT:-$(fc-match -f '%{file}' monospace)}
text() { echo "drawtext=fontfile='$1':text='$2':fontsize=$3:fontcolor=$4:x=(w-text_w)/2:y=$5"; }
ffmpeg -loglevel error -y -f lavfi -i "color=c=0x0d0d0d:s=1920x1080:r=30:d=$card" -i "$WORK/voice/outro.wav" -filter_complex \
  "[0:v]$(text "$font" "Thanks for watching" 104 0xF5A742 380),$(text "$font" "opencode-courier" 56 white 540),$(text "$mono" "opencode plugin add opencode-courier" 36 0x9a9a9a 640),$(text "$mono" "github.com/ivopogace/opencode-courier" 30 0x6a6a6a 710),fade=in:st=0:d=0.6,format=yuv420p[v];[1:a]adelay=500:all=1,apad,aresample=48000[a]" \
  -map '[v]' -map '[a]' -t "$card" -c:v libx264 -preset veryfast -crf 18 -c:a aac -ar 48000 -ac 2 "$WORK/outro.mp4"
printf "file '%s'\nfile '%s'\n" "$WORK/highlighted.mp4" "$WORK/outro.mp4" >"$WORK/final.txt"
ffmpeg -loglevel error -y -f concat -safe 0 -i "$WORK/final.txt" -c copy -movflags faststart "$OUT"
echo "wrote $OUT ($(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT" | cut -d. -f1) s)"
