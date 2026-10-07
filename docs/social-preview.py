# Renders docs/social-preview.png, the repository's suggested social preview, at 2x (2560x1280)
# as real text rather than GIF pixels. Upload it under Settings > General > Social preview.
#
#   python3 docs/social-preview.py [out.png]    (default: docs/social-preview.png)
#
# Needs Pillow and the Inter and DejaVu Sans Mono fonts at the paths below (Debian/Ubuntu:
# fonts-inter, fonts-dejavu-core). Keep the tagline in step with package.json's description.
import sys
from PIL import Image, ImageDraw, ImageFont

W, H = 2560, 1280
BG = "#0b0b10"
INTER = "/usr/share/fonts/opentype/inter/Inter-{}.otf"
MONO = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
MONO_B = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"
f = lambda w, s: ImageFont.truetype(INTER.format(w), s)

TEXT, GREEN, PURPLE, MUTED = "#eeeeee", "#87d787", "#af87d7", "#7a86b8"

# Everything stays 112 px (56 px at 1x) from both side edges, so a centre crop to 1.91:1
# (2444x1280) loses nothing. The left column and the terminal panel share a top and a bottom.
MARGIN, TOP, BOTTOM = 112, 210, 1070

README_ROWS = [
    [("## Report: math.js (from ses_ef95d4478ffemMauqk55uYppGm)", PURPLE, True)],
    [("- add(a, b) -> ", TEXT, False), ("`export function add(a, b)`", GREEN, False)],
    [("- subtract(a, b) -> ", TEXT, False), ("`export function subtract(a, b)`", GREEN, False)],
    [("File has 7 lines, 2 exported functions.", TEXT, False)],
    [],
    [("## Report: text.js (from ses_ef95d4477ffeAIRt2fAOxR7qdU)", PURPLE, True)],
    [("- shout(s) -> s.toUpperCase() + \"!\"", TEXT, False)],
    [("- whisper(s) -> s.toLowerCase()", TEXT, False)],
    [("- repeat(s, n) -> s.repeat(n)", TEXT, False)],
]
REPLY_ROWS = [
    [("\u2713 courier_cancel", MUTED, False)],
    [("Both reports received and added to ", TEXT, False), ("README.md", GREEN, False), (".", TEXT, False)],
    [("Cancelled the safety timer. Task complete.", TEXT, False)],
]

im = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(im)

# Left column: name, tagline, points, and the install call to action at the bottom.
X = MARGIN
d.text((X, TOP - 20), "opencode-courier", font=f("Bold", 88), fill="#f4f4f6")
d.text((X, TOP + 110), "Multi-session orchestration", font=f("Medium", 50), fill="#d0d0da")
d.text((X, TOP + 174), "for OpenCode V2", font=f("Medium", 50), fill="#d0d0da")
y = TOP + 290
for line in ["Spawn child sessions.", "Be woken when they report.", "Relay their questions.",
             "Wake on timers or webhooks.", "No polling."]:
    d.text((X, y), line, font=f("Regular", 40), fill="#a4a4b4")
    y += 58
d.rounded_rectangle((X, BOTTOM - 190, 930, BOTTOM), radius=22, fill="#1a1d33", outline="#8b97e0", width=4)
d.text((X + 40, BOTTOM - 162), "Install", font=f("Bold", 38), fill="#e6e8f5")
d.text((X + 40, BOTTOM - 90), "opencode plugin add opencode-courier", font=ImageFont.truetype(MONO_B, 32), fill="#b4c0ff")

# Terminal panel, redrawn from the last frame of docs/demo-async-tui.gif. Its 6 px frame ends
# at the right margin.
PX0, PY0, PX1, PY1 = 980, TOP + 6, W - MARGIN - 6, BOTTOM - 6
d.rounded_rectangle((PX0 - 6, PY0 - 6, PX1 + 6, PY1 + 6), radius=26, fill="#25263a")
d.rounded_rectangle((PX0, PY0, PX1, PY1), radius=22, fill="#080808")
mono, monob = ImageFont.truetype(MONO, 36), ImageFont.truetype(MONO_B, 36)
LH = 54
d.text((PX0 + 44, PY0 + 30), "README.md", font=monob, fill=MUTED)
README_TOP = PY0 + 92
d.rounded_rectangle((PX0 + 28, README_TOP, PX1 - 28, README_TOP + len(README_ROWS) * LH + 36), radius=12, fill="#141418")

def row(y, spans):
    x = PX0 + 56
    for text, colour, bold in spans:
        font = monob if bold else mono
        d.text((x, y), text, font=font, fill=colour)
        x += d.textlength(text, font=font)
        if x > PX1 - 40:
            raise SystemExit(f"row runs past the panel: {text!r}")

y = README_TOP + 18
for spans in README_ROWS:
    row(y, spans)
    y += LH
y += 62
for spans in REPLY_ROWS:
    row(y, spans)
    y += LH
if y > PY1 - 20:
    raise SystemExit(f"text runs past the bottom of the panel ({y} > {PY1 - 20})")

im.save(sys.argv[1] if len(sys.argv) > 1 else "docs/social-preview.png", optimize=True)
