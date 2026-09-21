#!/usr/bin/env python3
import json
import os
import subprocess
import sys
import traceback


def emit(value):
    print("DSH_MODEL_EVAL_RESULT=" + json.dumps(value, ensure_ascii=False), flush=True)


def read_payload():
    raw = sys.stdin.read()
    return json.loads(raw or "{}")


def main():
    payload = read_payload()
    action = payload.get("action")
    if action == "probe":
        try:
            import deepseek_harness  # noqa: F401
            emit({"ok": True, "python": sys.version.split()[0]})
        except Exception as exc:
            emit({"ok": False, "error": f"{type(exc).__name__}: {exc}", "hint": "python3 -m pip install deepseek-harness-sdk"})
        return

    if action == "command":
        try:
            proc = subprocess.run(payload.get("argv") or [], cwd=payload.get("cwd") or None, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
            emit({"ok": proc.returncode == 0, "returncode": proc.returncode, "stdout": proc.stdout, "stderr": proc.stderr})
        except Exception as exc:
            emit({"ok": False, "error": f"{type(exc).__name__}: {exc}"})
        return

    if action != "run":
        emit({"ok": False, "error": "unknown action"})
        return

    try:
        from deepseek_harness import DeepSeekHarness
        kwargs = {
            "dsh_home": os.path.abspath(payload["dshHome"]),
            "cwd": os.path.abspath(payload["cwd"]),
            "profile": payload.get("profile") or "sdk-minimal",
            "base_url": payload.get("baseUrl"),
            "api_key": payload.get("apiKey") or "EMPTY",
            "model": payload["model"],
            "max_tokens": int(payload.get("maxTokens") or 8192),
            "request_timeout_seconds": int(payload.get("requestTimeoutSeconds") or 120),
        }
        if payload.get("reasoningEffort"):
            kwargs["reasoning_effort"] = payload["reasoningEffort"]
        os.makedirs(kwargs["dsh_home"], exist_ok=True)
        with DeepSeekHarness(**kwargs) as harness:
            result = harness.run(payload["prompt"], session_id=payload.get("sessionId"))
        emit({
            "ok": True,
            "sessionId": result.session_id,
            "finalResponse": result.final_response,
            "finishReason": result.finish_reason,
            "eventCount": len(result.events or []),
            "notificationCount": len(result.notifications or []),
        })
    except Exception as exc:
        emit({
            "ok": False,
            "code": getattr(exc, "code", None),
            "error": f"{type(exc).__name__}: {exc}",
            "traceback": traceback.format_exc(limit=8),
        })


if __name__ == "__main__":
    main()
