"""把真实 rollout 事件的字段结构 dump 出来，供 adapter 精确对齐（不靠猜字段名）。

同时回答一个悬而未决的问题：Codex 的审批事件到底在不在日志里。
"""
from __future__ import annotations

import collections
import json
import sys
from pathlib import Path

HOME = Path.home()
SESSIONS = HOME / ".codex" / "sessions"
ARCHIVED = HOME / ".codex" / "archived_sessions"

APPROVAL_HINTS = ("approval", "permission", "trust", "confirm", "sandbox", "escalat")


def rollout_files(limit: int = 40) -> list[Path]:
    files = sorted(SESSIONS.rglob("rollout-*.jsonl")) + sorted(ARCHIVED.glob("rollout-*.jsonl"))
    return files[-limit:]


def main() -> int:
    files = rollout_files()
    print(f"扫描 {len(files)} 个 rollout 文件\n")

    shapes: dict[str, set[str]] = collections.defaultdict(set)
    counts: collections.Counter = collections.Counter()
    samples: dict[str, dict] = {}
    hint_hits: collections.Counter = collections.Counter()
    hint_samples: dict[str, str] = {}

    for f in files:
        with f.open(encoding="utf-8", errors="replace") as fh:
            for line in fh:
                try:
                    o = json.loads(line)
                except Exception:
                    continue
                t = o.get("type")
                p = o.get("payload") or {}
                pt = p.get("type") if isinstance(p, dict) else None
                key = f"{t}/{pt}" if pt else str(t)
                counts[key] += 1
                if isinstance(p, dict):
                    shapes[key] |= set(p.keys())
                samples.setdefault(key, p if isinstance(p, dict) else {})

                low = line.lower()
                for h in APPROVAL_HINTS:
                    if h in low:
                        hint_hits[f"{key} :: {h}"] += 1
                        if h not in hint_samples:
                            hint_samples[h] = line.strip()[:400]

    print("=== 事件类型与 payload 字段 ===")
    for key, n in counts.most_common():
        keys = ",".join(sorted(shapes.get(key, ())))
        print(f"{n:>6}  {key:<44} {keys}")

    print("\n=== 关键字段的实际取值（每类一个样本）===")
    for key in ("session_meta", "event_msg/task_started", "event_msg/task_complete",
                "event_msg/agent_message", "event_msg/token_count", "token_usage_record",
                "response_item/function_call", "response_item/function_call_output",
                "response_item/custom_tool_call", "response_item/custom_tool_call_output",
                "event_msg/patch_apply_end", "event_msg/turn_aborted"):
        s = samples.get(key)
        if s is None:
            continue
        keep = {k: v for k, v in s.items()
                if k in ("type", "turn_id", "call_id", "name", "status", "id", "message",
                         "output", "arguments", "command", "reason", "info", "total_token_usage",
                         "input_tokens", "output_tokens", "model", "cwd", "summary", "text")}
        if not keep:
            keep = dict(list(s.items())[:6])
        text = json.dumps(keep, ensure_ascii=False)
        print(f"\n[{key}]\n  {text[:600]}")

    print("\n=== 审批相关关键字命中 ===")
    if not hint_hits:
        print("  没有任何命中 —— 审批事件不在 rollout 日志里")
    else:
        for k, n in hint_hits.most_common(20):
            print(f"{n:>6}  {k}")
        print("\n  样本：")
        for h, s in list(hint_samples.items())[:4]:
            print(f"  [{h}] {s}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
