#!/usr/bin/env python3
"""Connectivity check for Jev (TypeSafe AI System One).

Reads TYPESAFE_API_KEY from .env (current directory, or the path in GAME_QA_ENV), sends one
POST /v1/systemone and prints the raw response. Standard library only.

  python3 tools/check_jev.py
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request

API_URL = "https://api.typesafe.ai/v1/systemone"
ENV_PATH = os.environ.get("GAME_QA_ENV", ".env")  # run from the directory that holds your .env, or set GAME_QA_ENV


def load_env(path: str) -> dict:
    env = {}
    if not os.path.exists(path):
        return env
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            env[key.strip()] = value.strip()
    return env


def main() -> int:
    env = load_env(ENV_PATH)
    api_key = env.get("TYPESAFE_API_KEY") or os.environ.get("TYPESAFE_API_KEY")

    if not api_key or api_key == "your-api-key":
        print(f"TYPESAFE_API_KEY is not set. Put it in {ENV_PATH}.")
        print("Get a key at https://console.typesafe.ai/")
        return 1

    # Minimal dummy request shaped like a game QA decision
    payload = {
        "model": "jev-latest",
        "state": {
            "screen": "home",
            "goal": "daily run",
            "candidates": ["Start", "Shop", "Close"],
        },
        "questions": {
            "next_tap": {
                "type": "choice",
                "instructions": "Which button should be tapped next?",
                "criteria": {
                    "A1": "Start",
                    "A2": "Shop",
                    "A3": "Close",
                },
            },
            "looks_stable": {
                "type": "noul",
                "instructions": "Does this screen look broken, e.g. showing an error?",
            },
        },
    }

    req = urllib.request.Request(
        API_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )

    print(f"POST {API_URL}")
    start = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            elapsed = (time.monotonic() - start) * 1000
            body = json.loads(resp.read().decode("utf-8"))
            print(f"status={resp.status}  elapsed={elapsed:.0f}ms")
            print(json.dumps(body, ensure_ascii=False, indent=2))
            return 0
    except urllib.error.HTTPError as e:
        elapsed = (time.monotonic() - start) * 1000
        detail = e.read().decode("utf-8", errors="replace")
        print(f"status={e.code}  elapsed={elapsed:.0f}ms")
        print(detail)
        if e.code == 401:
            print("-> The API key is invalid. Check TYPESAFE_API_KEY in .env.")
        elif e.code == 422:
            print("-> Request validation error. Check the payload shape.")
        elif e.code in (429, 529):
            print("-> Rate limited. Try again later.")
        return 1
    except urllib.error.URLError as e:
        print(f"Connection failed: {e.reason}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
