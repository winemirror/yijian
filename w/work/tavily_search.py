#!/usr/bin/env python3
"""Tavily search helper. Prints UTF-8 results for a given query."""
import json
import sys
import urllib.request

API_KEY = "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"
ENDPOINT = "https://api.tavily.com/search"


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: tavily_search.py <query> [max_results] [topic]",
              file=sys.stderr)
        return 2

    query = sys.argv[1]
    max_results = int(sys.argv[2]) if len(sys.argv) > 2 else 5
    topic = sys.argv[3] if len(sys.argv) > 3 else "general"

    payload = {
        "query": query,
        "max_results": max_results,
        "topic": topic,
        "include_answer": True,
    }
    req = urllib.request.Request(
        ENDPOINT,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {API_KEY}",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    out = {"query": data.get("query"), "answer": data.get("answer"),
           "results": []}
    for item in data.get("results", []):
        out["results"].append({
            "title": item.get("title"),
            "url": item.get("url"),
            "content": item.get("content"),
            "score": item.get("score"),
        })

    sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
