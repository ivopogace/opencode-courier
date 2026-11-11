# /// script
# requires-python = ">=3.10"
# dependencies = ["kokoro-onnx>=0.4", "soundfile", "huggingface_hub"]
# ///
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
style = np.fromfile(hf_hub_download(REPO, f"voices/{voice}.bin"), dtype=np.float32).reshape(-1, 1, 256)
np.savez(out / "voices.npz", **{voice: style})
kokoro = Kokoro(hf_hub_download(REPO, "onnx/model.onnx"), str(out / "voices.npz"))


def speak(text, name):
    audio, rate = kokoro.create(text, voice=voice, speed=narration.get("speed", 1.0), lang="en-us")
    sf.write(out / f"{name}.wav", audio, rate)
    print(f"{name}: {len(audio) / rate:.1f} s")
    return len(audio) / rate


seconds = [speak(text, index) for index, text in enumerate(narration["scenes"].values())]
(out / "voice.json").write_text(json.dumps({"seconds": seconds, "outro": speak(narration["outro"], "outro")}))
