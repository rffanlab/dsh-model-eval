# Changelog

## 0.1.2

- Fix first-run protocol probing for MiniMax and stricter OpenAI-compatible gateways.
- Try a minimal request first, then probe token-limit and temperature fields independently.
- Probe both `/chat/completions` and MiniMax-compatible `/text/chatcompletion_v2`; reuse the path that actually passed.
- Resolve explicit model display spellings against `/models` only when there is one unambiguous canonical match; never select the catalog's first model for an explicit request.
- Add MiniMax regression coverage for `MiniMax M3.1-Flash-Preview` → `MiniMax-M3.1-Flash-Preview`.
- Separate invalid model, authentication, route/protocol, and capability failures in diagnostics.
- Pass the probed token field into the isolated DSH `llm-pi-ai` provider.
- Show requested model, selected model, API-reported model, successful path, and every protocol attempt in the Web UI.

## 0.1.0

- Initial runnable evaluation engine.
- Web UI and headless CLI.
- OpenAI-compatible endpoint/model/protocol discovery.
- Deterministic instruction, JSON, tool-call, context and performance cases.
- Optional DeepSeek Harness Python SDK agent bridge.
- Hidden file and recovery acceptance checks.
- Full-suite ffmpeg/ffprobe video artifact case.
- Image/document/video/audio artifact collection and rich HTML report.
- Run history, Markdown report, SVG summary and JSON model card.
