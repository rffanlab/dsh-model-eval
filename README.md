# dsh-model-eval

中文 | [English](README.en.md)

给 DeepSeek Harness 做“一键模型验收”的插件。你只需要提供一个模型 API 地址、API Key（可选）和 Model ID（可自动发现），插件会自动完成协议探测、固定能力题、工具调用、上下文召回、DSH Agent 隐藏验收、恢复能力、性能记录和多媒体产物报告。

> 目标不是只回答“这个模型考试多少分”，而是回答：**把它交给 DSH 干活，能不能稳定、无人值守地把真实产物交付出来。**

## 当前版本

**0.1.0**：第一版可运行骨架。

已经实现：

- Web UI：设置 → 插件 → **模型评测**；
- OpenAI Chat Completions / Responses 自动协议探测；
- `/models` 自动发现；
- Smoke / Standard / Full 三档套件；
- 严格指令、严格 JSON、工具调用、延迟样本；
- 4K ～ 128K 估算上下文召回（Full 按声明 Context 自动截顶）；
- DeepSeek Harness Python SDK 隔离 Agent Case；
- Agent 文件交付隐藏验收；
- Agent 失败修复 + 外部重跑测试；
- Full 模式下 ffmpeg 视频交付 + ffprobe 外部验收；
- 图片 / 视频 / 音频 / PDF / Office / Markdown / 文本等 Artifact 自动归档；
- HTML 报告直接显示图片、播放视频/音频、内嵌 PDF，并提供文档打开/下载；
- `report.md`、`report.html`、`summary.svg`、`model-card.json`、`run.json`；
- 历史 Run 列表；
- API Key 不写入 Run 记录或报告；
- CLI 入口，可脱离 Web UI 跑同一套引擎。

## 安装

Web profile：

```bash
dsh plugin --profile web add github:rffanlab/dsh-model-eval
```

更新：

```bash
dsh plugin --profile web update dsh-model-eval
```

更新后重启 DSH Web Host，并强制刷新浏览器。

### DSH Agent 评测依赖

普通 API / 指令 / 工具 / Context 测试不依赖 Python SDK。

要运行真正的 **DSH Agent Case**，评测 Host 上的 `python3` 需要能导入 DeepSeek Harness SDK：

```bash
python3 -m pip install deepseek-harness-sdk
```

如果 SDK 安装在独立 Python 中：

```bash
export DSH_MODEL_EVAL_PYTHON=/path/to/python
```

插件不会偷偷安装系统依赖；SDK 不存在时 Agent Case 会明确标记 `DSH_SDK_UNAVAILABLE` 并跳过，而不是伪装成模型失败。

## 使用

入口：

```text
设置
→ 插件
→ 模型评测
```

填写：

```text
API Base URL   http://127.0.0.1:8001/v1
API Key        可空 / EMPTY
Model ID       auto 或明确模型 ID
Suite          Smoke / Standard / Full
Context        可选，例如 131072
```

点击 **开始自动评测**。

评测完成后页面直接显示报告。报告中的：

- SVG/PNG/JPEG/WebP 等图片会直接展示；
- MP4/WebM/MOV 等视频通过 HTTP Range 直接播放和拖动；
- MP3/WAV/FLAC 等音频直接播放；
- PDF 内嵌预览；
- DOCX/XLSX/PPTX/Markdown/文本等提供打开/下载；
- 每个 Case 的产物、隐藏验收、耗时、失败分类都保留。

## 三档套件

### Smoke

用于刚起一个模型快速确认：

- 模型发现；
- 协议探测；
- 严格输出；
- JSON；
- 工具调用；
- 基础延迟。

### Standard

日常模型比较默认使用：

- Smoke 全部；
- 约 4K Context 召回；
- DSH Agent 文件交付；
- 图片 + 文档 Artifact 归档。

### Full

生产模型完整验收：

- Standard 全部；
- 8K / 16K / 32K / 64K / 96K / 128K Context 召回；
- DSH Agent 失败恢复；
- ffmpeg 视频交付；
- ffprobe 外部可播放性验收；
- 图片、文档、视频统一进入报告。

> Full 会发送很大的 Prompt。对按 Token 收费的远端 API，运行前请确认成本。

## Artifact 规则

DSH Agent Case 约定把正式交付放入：

```text
deliverables/
```

插件在 Case 结束后复制到 Run 自己的只读历史目录：

```text
$DSH_HOME/model-eval/<RUN_ID>/artifacts/<CASE_ID>/
```

当前识别：

```text
image:    png jpg jpeg gif webp avif bmp svg
video:    mp4 webm mov m4v mkv ogv
audio:    mp3 wav ogg m4a aac flac opus
document: pdf doc docx rtf odt xls xlsx ods ppt pptx odp md txt csv json html
```

单个 Artifact 默认上限 512 MB，每个 Case 最多收集 200 个，避免一个失控 Agent 把整个磁盘复制进报告。

## 报告目录

```text
$DSH_HOME/model-eval/<RUN_ID>/
├── run.json
├── report.md
├── report.html
├── summary.svg
├── model-card.json
├── artifacts/
├── workspaces/
└── dsh-home/
```

`run.json` **不保存 API Key**，只保存 `apiKeyPresent: true/false`。

## CLI

在仓库开发环境：

```bash
node ./bin/dsh-model-eval.mjs --base-url http://127.0.0.1:8001/v1 --api-key EMPTY --model auto --suite standard --output ./eval-results
```

安装成可执行包后：

```bash
dsh-model-eval --base-url http://127.0.0.1:8001/v1 --api-key EMPTY --model auto --suite full --context 131072
```

不跑 DSH Agent：

```bash
dsh-model-eval --base-url http://127.0.0.1:8001/v1 --model auto --suite standard --no-dsh-agent
```

## 安全边界

- API 地址只允许 `http://` / `https://`；
- API Key 仅在 Host 本次运行内存和 DSH SDK 子进程 stdin 中传递；
- API Key 不进入命令行参数，不进入 `run.json` / HTML / Markdown；
- Artifact 浏览接口只能读取对应 Run 目录；
- 视频使用流式读取和 Range，不把大文件一次性读入内存；
- hidden evaluator 位于 Agent workspace 外，Candidate 无法通过改测试文件伪造通过；
- SDK 缺失、ffmpeg 缺失分别标记环境原因，不直接记成模型智力失败。

## 设计原则

1. **能程序验收就不让 LLM Judge 判。**
2. **模型说“完成”不算完成，外部 hidden check 通过才算。**
3. **协议问题、环境问题、模型问题必须分开。**
4. **Skipped 不进入通过率分母。**
5. **每个 DSH Agent Case 使用独立 workspace、独立 DSH home、独立 session id。**
6. **真实业务踩坑应沉淀成新的 Regression Case。**

完整操作手册见：[docs/OPERATION_MANUAL.md](docs/OPERATION_MANUAL.md)。

## 开发

Node.js 20+：

```bash
npm run check
npm test
npm run packcheck
```

测试包含本地 fake OpenAI server 的端到端链路：模型发现、Chat Completions、严格指令、JSON、工具调用、Context、最终报告生成。

## 下一阶段

0.2 重点：

- 正式 Case registry / 外部 Case 包；
- baseline / regression 自动对比；
- DSH Context compaction / resume 专用 Case；
- Vision 输入 Case；
- 多轮稳定性 3x/5x；
- TTFT streaming 精确统计；
- 与 `dsh-model-mgr` 模型详情页联动；
- 与 `dsh-media-viewer` 做更深的 Office 结构化预览联动。

## License

MIT
