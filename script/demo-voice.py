# /// script
# requires-python = ">=3.10"
# dependencies = ["kokoro-onnx>=0.4", "soundfile", "huggingface_hub"]
# ///
"""Speaks script/demo-narration.json with Kokoro-82M from Hugging Face, for script/render-demo.sh.

    uv run script/demo-voice.py <narration.json> <out dir>

Writes <out dir>/<n>.wav for the n-th scene in the file's order, and <out dir>/voice.json with each one's
seconds. The model and voice come from onnx-community/Kokoro-82M-v1.0-ONNX, cached by huggingface_hub."""
import json
import sys
from pathlib import Path

import numpy as np
import soundfile as sf
from huggingface_hub import hf_hub_download
from kokoro_onnx import Kokoro

REPO = "onnx-community/Kokoro-82M-v1.0-ONNX"

narration_path, out = Path(sys.argv[1]), Path(sys.argv[2])
narration = json.loads(narration_path.read_text())
voice = narration.get("voice", "af_heart")
out.mkdir(parents=True, exist_ok=True)
# kokoro-onnx reads its voices from one .npz; the Hugging Face export has a raw float32 file per voice.
style = np.fromfile(hf_hub_download(REPO, f"voices/{voice}.bin"), dtype=np.float32).reshape(-1, 1, 256)
np.savez(out / "voices.npz", **{voice: style})
kokoro = Kokoro(hf_hub_download(REPO, "onnx/model.onnx"), str(out / "voices.npz"))

seconds = []
for index, text in enumerate(narration["scenes"].values()):
    audio, rate = kokoro.create(text, voice=voice, speed=narration.get("speed", 1.0), lang="en-us")
    sf.write(out / f"{index}.wav", audio, rate)
    seconds.append(len(audio) / rate)
    print(f"{index}: {seconds[-1]:.1f} s")
(out / "voice.json").write_text(json.dumps({"seconds": seconds}))
