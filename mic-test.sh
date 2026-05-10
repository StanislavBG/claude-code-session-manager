#!/usr/bin/env bash
# Mic test: records 3s and prints live VU meter + peak level to this terminal.
set -euo pipefail

DUR=3
OUT=$(mktemp --suffix=.wav)
trap 'rm -f "$OUT"' EXIT

echo "Recording ${DUR}s from default mic — speak now..."
arecord -q -f S16_LE -r 44100 -c 1 -d "$DUR" -V mono "$OUT" 2>&1 | tee /dev/tty >/dev/null

echo
echo "--- Result ---"
# Peak level analysis via ffmpeg volumedetect (stderr carries the stats).
ffmpeg -hide_banner -nostats -i "$OUT" -af volumedetect -f null /dev/null 2>&1 \
  | grep -E "mean_volume|max_volume|n_samples" || true

SIZE=$(stat -c%s "$OUT")
echo "WAV bytes: $SIZE"
if [ "$SIZE" -lt 10000 ]; then
  echo "FAIL: file too small — mic likely not capturing."
  exit 1
fi
echo "OK: capture produced audio data."
