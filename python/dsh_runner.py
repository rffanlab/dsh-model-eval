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
        dsh_home = os.path.abspath(payload["dshHome"])
        os.makedirs(dsh_home, exist_ok=True)
        provider_id = "model-eval-candidate"
        protocol = payload.get("protocol") or "openai-completions"
        if protocol not in ("openai-completions", "openai-responses"):
            raise ValueError(f"unsupported DSH candidate protocol: {protocol}")
        key_env = "DSH_MODEL_EVAL_CANDIDATE_API_KEY"
        candidate_key = payload.get("apiKey") or "EMPTY"
        model_profile = {"id": payload["model"], "input": ["text"]}
        if payload.get("declaredContext"):
            model_profile["contextWindow"] = int(payload["declaredContext"])
        route = {
            "apiKeyEnv": key_env,
            "displayName": "Model Eval Candidate",
            "api": protocol,
            "baseURL": payload.get("baseUrl"),
            "models": [model_profile],
        }
        if protocol == "openai-completions":
            # The direct endpoint probe already proved max_tokens works. These
            # conservative switches cover the common self-hosted gateways that
            # reject developer role / max_completion_tokens.
            route["compat"] = {
                "supportsDeveloperRole": False,
                "maxTokensField": "max_tokens",
            }
        with open(os.path.join(dsh_home, "settings.yaml"), "w", encoding="utf-8") as fh:
            # JSON is valid YAML and avoids adding a PyYAML dependency.
            json.dump({"llm-pi-ai": {"providers": {provider_id: route}}}, fh, ensure_ascii=False, indent=2)
        kwargs = {
            "dsh_home": dsh_home,
            "cwd": os.path.abspath(payload["cwd"]),
            "profile": payload.get("profile") or "sdk",
            "provider": provider_id,
            "env": {
                key_env: candidate_key,
                "DSH_TELEMETRY_DISABLED": "1",
                "DSH_PERMISSION_MODE": "workspace-write",
            },
            "model": payload["model"],
            "max_tokens": int(payload.get("maxTokens") or 8192),
            "request_timeout_seconds": int(payload.get("requestTimeoutSeconds") or 120),
        }
        if payload.get("reasoningEffort"):
            kwargs["reasoning_effort"] = payload["reasoningEffort"]
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
