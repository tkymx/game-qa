#!/bin/bash
# Set up Laya-MLX (local decision engine). Requires Apple Silicon and uv.
# Python 3.12 is pinned because MLX wheels are not available for every newer Python yet.
set -euo pipefail
cd "$(dirname "$0")"
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python laya-mlx
# Download the multilingual checkpoint (~650MB) now so the first QA run starts quickly
.venv/bin/python -c 'import laya_mlx as laya; laya.load("aac6fef/laya-multilingual-mlx"); print("laya ready")'
