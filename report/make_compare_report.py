#!/usr/bin/env python3
"""Build the HTML comparison report from a `game-qa compare` run.

  python3 report/make_compare_report.py <compare-dir> [--verdict=verdict.html]
  output: <compare-dir>/report/{index.html, side/*.mp4}
"""
import argparse
import json
import shutil
from pathlib import Path

KEEP = ["seed", "scenario", "provider", "model", "result", "success", "elapsedSec", "finalHp", "damage", "hits",
        "defeated", "decisions", "decisionsPerSec", "latencyP50", "latencyP95", "guardShare", "centerAvg",
        "centerMax", "fpsP50", "hpTimeline"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("compare_dir")
    ap.add_argument("--verdict", default=None)
    args = ap.parse_args()
    d = Path(args.compare_dir)
    data = json.loads((d / "results.json").read_text())
    # Do not leak local paths (they contain the user name) into the report
    data["results"] = [{k: r.get(k) for k in KEEP} for r in data["results"]]
    out = d / "report"
    (out / "side").mkdir(parents=True, exist_ok=True)
    for mp4 in sorted((d / "side").glob("*.mp4")):
        shutil.copy(mp4, out / "side" / mp4.name)
    template = (Path(__file__).parent / "report_template.html").read_text()
    verdict = Path(args.verdict).read_text() if args.verdict else ""
    html = template.replace("/*__DATA__*/null", json.dumps(data, ensure_ascii=False)).replace("<!--__VERDICT__-->", verdict)
    (out / "index.html").write_text(html)
    print(out / "index.html")


if __name__ == "__main__":
    main()
