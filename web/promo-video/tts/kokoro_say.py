#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10,<3.14"
# dependencies = ["kokoro-onnx==0.6.1", "soundfile>=0.12"]
# ///
"""Local, free narration for the promo video via Kokoro-82M (Apache-2.0) + kokoro-onnx (MIT).

Run with uv (it resolves the deps from the header above):

  uv run kokoro_say.py --voice af_heart --speed 1.0 --text "Hello." --out hello.wav
  uv run kokoro_say.py --script lines.json --outdir out/          # batch -> <id>.wav + manifest.json
  uv run kokoro_say.py --list-voices

lines.json: [{"id": "s01", "text": "...", "voice": "af_heart", "speed": 1.0, "lang": "en-us"?}, ...]
`voice`/`speed` fall back to the CLI --voice/--speed; `lang` is inferred from the voice prefix.
A voice may be a blend: "af_heart:0.7,af_bella:0.3".

Model dir: $SM_PROMO_KOKORO_DIR or --model-dir (default ~/.cache/sm-promo/kokoro), holding
kokoro-v1.0.onnx (or kokoro-v1.0.fp16.onnx / kokoro-v1.0.int8.onnx) and voices-v1.0.bin from
https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files-v1.0
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

DEFAULT_DIR = Path.home() / ".cache" / "sm-promo" / "kokoro"
MODEL_CANDIDATES = ("kokoro-v1.0.onnx", "kokoro-v1.0.fp16.onnx", "kokoro-v1.0.int8.onnx")
VOICES_FILE = "voices-v1.0.bin"
# First letter of a Kokoro voice id = language (a=US English, b=UK English, ...).
LANG_BY_PREFIX = {
    "a": "en-us", "b": "en-gb", "e": "es", "f": "fr-fr", "h": "hi",
    "i": "it", "j": "ja", "p": "pt-br", "z": "cmn",
}


def resolve_model_dir(cli_dir: str | None) -> Path:
    return Path(cli_dir or os.environ.get("SM_PROMO_KOKORO_DIR") or DEFAULT_DIR).expanduser()


def load_kokoro(model_dir: Path):
    from kokoro_onnx import Kokoro

    model = next((model_dir / m for m in MODEL_CANDIDATES if (model_dir / m).is_file()), None)
    voices = model_dir / VOICES_FILE
    if model is None or not voices.is_file():
        sys.exit(
            f"kokoro_say: missing model files in {model_dir} "
            f"(need one of {', '.join(MODEL_CANDIDATES)} and {VOICES_FILE})"
        )
    return Kokoro(str(model), str(voices)), model.name


def resolve_voice(kokoro, spec: str):
    """Return (voice_arg, primary_id). spec is 'id' or a weighted blend 'id:w,id:w'."""
    available = set(kokoro.get_voices())
    parts = [p.strip() for p in spec.split(",") if p.strip()]
    if len(parts) == 1 and ":" not in parts[0]:
        if parts[0] not in available:
            sys.exit(f"kokoro_say: unknown voice '{parts[0]}'. Try --list-voices.")
        return parts[0], parts[0]
    style, total = None, 0.0
    for part in parts:
        vid, _, w = part.partition(":")
        weight = float(w) if w else 1.0
        if vid not in available:
            sys.exit(f"kokoro_say: unknown voice '{vid}' in blend '{spec}'.")
        s = kokoro.get_voice_style(vid) * weight
        style = s if style is None else style + s
        total += weight
    return style / total, parts[0].partition(":")[0]


def lang_for(voice_id: str, override: str | None) -> str:
    return override or LANG_BY_PREFIX.get(voice_id[:1], "en-us")


def synth(kokoro, text: str, voice: str, speed: float, lang: str | None):
    voice_arg, primary = resolve_voice(kokoro, voice)
    lg = lang_for(primary, lang)
    samples, sr = kokoro.create(text, voice=voice_arg, speed=speed, lang=lg)
    return samples, sr, lg


def write_wav(path: Path, samples, sr: int) -> float:
    import soundfile as sf

    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), samples, sr, subtype="PCM_16")
    return round(len(samples) / sr, 3)


def safe_id(raw: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", str(raw)).strip("._")
    if not cleaned:
        sys.exit(f"kokoro_say: line id '{raw}' is empty after sanitizing")
    return cleaned


def run_batch(kokoro, model_name: str, args) -> None:
    lines = json.loads(Path(args.script).read_text(encoding="utf-8"))
    if not isinstance(lines, list):
        sys.exit("kokoro_say: --script must be a JSON array of {id, text, voice?, speed?, lang?}")
    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    clips, seen, sr_out = [], set(), 24000
    for i, line in enumerate(lines):
        if not isinstance(line, dict) or not line.get("text") or line.get("id") is None:
            sys.exit(f"kokoro_say: line {i} needs non-empty 'id' and 'text'")
        cid = safe_id(line["id"])
        if cid in seen:
            sys.exit(f"kokoro_say: duplicate id '{cid}'")
        seen.add(cid)
        voice = line.get("voice") or args.voice
        speed = float(line.get("speed") or args.speed)
        samples, sr, lg = synth(kokoro, line["text"], voice, speed, line.get("lang") or args.lang)
        sr_out = sr
        dur = write_wav(outdir / f"{cid}.wav", samples, sr)
        clips.append({"id": cid, "file": f"{cid}.wav", "duration": dur, "voice": voice,
                      "speed": speed, "lang": lg, "text": line["text"]})
        print(f"{cid}.wav\t{dur:.3f}s\t{voice}", file=sys.stderr)
    manifest = {"model": model_name, "sample_rate": sr_out, "clips": clips,
                "total_duration": round(sum(c["duration"] for c in clips), 3)}
    (outdir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"manifest": str(outdir / "manifest.json"), "clips": len(clips),
                      "total_duration": manifest["total_duration"]}))


def main() -> None:
    ap = argparse.ArgumentParser(description="Kokoro-82M local TTS for the promo video.")
    ap.add_argument("--voice", default="af_heart", help="voice id or blend 'a:0.7,b:0.3'")
    ap.add_argument("--speed", type=float, default=1.0)
    ap.add_argument("--lang", default=None, help="override language (default: from voice prefix)")
    ap.add_argument("--text")
    ap.add_argument("--out")
    ap.add_argument("--script", help="batch JSON: [{id,text,voice?,speed?,lang?}]")
    ap.add_argument("--outdir")
    ap.add_argument("--model-dir", default=None)
    ap.add_argument("--list-voices", action="store_true")
    args = ap.parse_args()

    kokoro, model_name = load_kokoro(resolve_model_dir(args.model_dir))

    if args.list_voices:
        print("\n".join(sorted(kokoro.get_voices())))
        return
    if args.script:
        if not args.outdir:
            ap.error("--script requires --outdir")
        run_batch(kokoro, model_name, args)
        return
    if not (args.text and args.out):
        ap.error("single mode needs --text and --out (or use --script/--outdir, --list-voices)")
    samples, sr, lg = synth(kokoro, args.text, args.voice, args.speed, args.lang)
    dur = write_wav(Path(args.out), samples, sr)
    print(json.dumps({"out": args.out, "duration": dur, "voice": args.voice, "speed": args.speed,
                      "lang": lg, "sample_rate": sr, "model": model_name}))


if __name__ == "__main__":
    main()
