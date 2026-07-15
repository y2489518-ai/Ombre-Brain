"""
surfacing_trace.py — 浮现/关联/去重决策的 JSONL 尸检日志

只存 bucket_id 和 reason，不存正文——日志是尸检报告不是第二份记忆。
10MB 滚动。
"""

import json
import os
import time
from pathlib import Path

_MAX_BYTES = 10 * 1024 * 1024  # 10 MB

_log_path: Path | None = None


def init(buckets_dir: str) -> None:
    global _log_path
    _log_path = Path(buckets_dir) / "surfacing_trace.jsonl"


def _rotate_if_needed() -> None:
    if _log_path and _log_path.exists():
        try:
            if _log_path.stat().st_size > _MAX_BYTES:
                bak = _log_path.with_suffix(".jsonl.old")
                if bak.exists():
                    bak.unlink()
                _log_path.rename(bak)
        except OSError:
            pass


def log(action: str, bucket_id: str, reason: str, **extra) -> None:
    if not _log_path:
        return
    _rotate_if_needed()
    entry = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "action": action,
        "bucket_id": bucket_id,
        "reason": reason,
    }
    entry.update(extra)
    try:
        with open(_log_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except OSError:
        pass
