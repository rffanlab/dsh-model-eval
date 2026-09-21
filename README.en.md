# dsh-model-eval

[中文](README.md) | English

One-click model acceptance testing for DeepSeek Harness. Provide an API base URL, optional API key, and a model id (or `auto`), then run deterministic endpoint, instruction, JSON, tool-call, context, DSH-agent, recovery, performance, and artifact-delivery checks.

The goal is not merely benchmark scores. The primary question is whether a model can reliably deliver real work when used by DSH.

## Highlights

- DSH Web UI under Settings → Plugins → Model Evaluation
- OpenAI Chat Completions / Responses probing
- `/models` discovery
- Smoke / Standard / Full suites
- strict instruction and JSON checks
- tool-call argument validation
- estimated 4K–128K context recall
- isolated DeepSeek Harness Python SDK agent cases
- external hidden acceptance checks
- recovery case with evaluator-owned test rerun
- Full-suite ffmpeg video delivery + ffprobe validation
- artifact collection for images, video, audio and documents
- HTML report with inline images, playable video/audio and PDF preview
- Markdown, SVG summary, JSON model card and raw run record
- API keys are never written to run records or reports

## Install

```bash
dsh plugin --profile web add github:rffanlab/dsh-model-eval
```

For DSH agent cases:

```bash
python3 -m pip install deepseek-harness-sdk
```

If the SDK uses another Python:

```bash
export DSH_MODEL_EVAL_PYTHON=/path/to/python
```

## CLI

```bash
dsh-model-eval --base-url http://127.0.0.1:8001/v1 --api-key EMPTY --model auto --suite full --context 131072
```

See the Chinese [operation manual](docs/OPERATION_MANUAL.md) for the full SOP.

## License

MIT
