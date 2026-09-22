#!/usr/bin/env python3
"""Build side-by-side (Jev | Laya) comparison videos from a `game-qa compare` run.

  python3 report/make_compare_videos.py <runtimeDir>/compare-<timestamp>
  output: <compare-dir>/side/<scenario>-seed<N>.mp4

Each lane gets a label bar (engine, result, final HP, median decision time). The shorter lane
holds its last frame so both end together. A scenario's "reportVideoSpeed" speeds its video up.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

# A font that can draw the labels (Japanese by default). Override with GAME_QA_FONT.
FONT_SRC = Path(os.environ.get("GAME_QA_FONT", "/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc"))
LANE_W, LANE_H, BAR_H = 360, 634, 56
NAMES = {"jev": "Jev（クラウド）", "laya": "Laya（ローカルMLX）"}
RESULT = {"win": "全滅させて勝利", "survived": "生存", "lose": "敗北", "timeout": "時間切れ"}


def duration(p):
    out = subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(p)])
    return float(out)


def esc(text):
    return text.replace("\\", "\\\\").replace(":", "\\:").replace("'", "’").replace("%", "\\%")


def main(compare_dir):
    compare_dir = Path(compare_dir)
    data = json.loads((compare_dir / "results.json").read_text())
    results = data["results"]
    meta = data.get("scenarioMeta", {})
    out_dir = compare_dir / "side"
    out_dir.mkdir(exist_ok=True)
    tmp = Path(tempfile.mkdtemp())
    font = tmp / "font.ttc"  # ffmpegのフィルタ式で日本語パスをエスケープしないで済むようにコピーする
    shutil.copy(FONT_SRC, font)

    pairs = {}
    for r in results:
        pairs.setdefault((r["scenario"], r["seed"]), {})[r["provider"]] = r
    for (scenario, seed), by in sorted(pairs.items()):
        if not all(p in by and by[p].get("videoPath") for p in ("jev", "laya")):
            continue
        speed = float(meta.get(scenario, {}).get("videoSpeed", 1))
        target = max(duration(by[p]["videoPath"]) for p in ("jev", "laya")) / speed
        inputs, filters = [], []
        for i, p in enumerate(("jev", "laya")):
            r = by[p]
            inputs += ["-i", r["videoPath"]]
            line1 = NAMES.get(p, p)
            line2 = f"{RESULT.get(r['result'], r['result'])}  HP {r['finalHp']}  判定 {r['latencyP50']}ms"
            filters.append(
                f"[{i}:v]setpts=PTS/{speed},scale={LANE_W}:{LANE_H},"
                f"tpad=stop_mode=clone:stop_duration={target + 1:.2f},trim=duration={target:.2f},"
                f"pad={LANE_W}:{LANE_H + BAR_H}:0:{BAR_H}:color=0x151826,"
                f"drawtext=fontfile={font}:text='{esc(line1)}':x=12:y=8:fontsize=18:fontcolor=white,"
                f"drawtext=fontfile={font}:text='{esc(line2)}':x=12:y=32:fontsize=14:fontcolor=0xb8bfd6[v{i}]"
            )
        speed_note = f"  {speed:g}倍速" if speed != 1 else ""
        filters.append(f"[v0][v1]hstack=inputs=2,drawbox=x={LANE_W - 1}:y=0:w=2:h=ih:color=0x2e3450:t=fill,"
                       f"drawtext=fontfile={font}:text='seed {seed}{esc(speed_note)}':x=w-tw-12:y=h-26:fontsize=13:fontcolor=0x8a91a8[out]")
        out = out_dir / f"{scenario}-seed{seed}.mp4"
        subprocess.run(["ffmpeg", "-v", "error", "-y", *inputs, "-filter_complex", ";".join(filters), "-map", "[out]",
                        "-r", "30", "-c:v", "libx264", "-crf", "28", "-preset", "slow", "-pix_fmt", "yuv420p",
                        "-movflags", "+faststart", str(out)], check=True)
        print(out, f"{out.stat().st_size / 1e6:.1f}MB")


if __name__ == "__main__":
    main(sys.argv[1])
