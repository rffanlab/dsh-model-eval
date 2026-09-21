# DSH 模型完整评测操作手册

本文档定义 `dsh-model-eval` 的标准验收流程。目标是让不同模型、量化、推理框架和 API Provider 在同一套规则下可重复比较。

## 1. 一次完整验收的输入

原则上只需要：

```text
API Base URL
API Key（可空）
Model ID（可 auto）
```

可选声明：

```text
Context Window
Suite
```

不要在一轮对比中同时改变 Prompt、DSH 版本、推理框架、量化、Context 和采样策略。一次尽量只改变一个变量。

## 2. 评测前检查

### 2.1 普通 API 测试

无需额外依赖。

### 2.2 DSH Agent 测试

确认：

```bash
python3 -c "import deepseek_harness; print('DSH SDK OK')"
```

若失败：

```bash
python3 -m pip install deepseek-harness-sdk
```

如果 DSH 服务使用的 PATH 中 `python3` 不是这个 Python，给服务增加：

```text
DSH_MODEL_EVAL_PYTHON=/绝对路径/python
```

### 2.3 视频产物测试

Full 的视频 Case 需要：

```bash
ffmpeg -version
ffprobe -version
```

缺失时该 Case 自动 Skip，不把环境缺工具误判成模型失败。

## 3. 标准执行顺序

系统自动执行：

```text
01 Endpoint Discovery
02 Protocol Fingerprint
03 Instruction Exact
04 Strict JSON
05 Tool Calling
06 Performance Sample
07 Context Recall
08 DSH Agent Artifact Delivery
09 DSH Agent Recovery          [Full]
10 DSH Agent Media Delivery    [Full]
11 Artifact Collection
12 Hidden Evaluation
13 Report Generation
```

## 4. Endpoint Discovery

首先请求：

```text
GET <baseUrl>/models
```

识别：

```json
{"data":[{"id":"model-a"}]}
```

以及：

```json
{"models":[...]}
```

如果 `Model ID=auto` 且无法发现模型，评测中止并要求明确 Model ID。

`/models` 失败本身不代表推理不可用；明确指定 Model ID 时仍可继续协议探测。

## 5. Protocol Fingerprint

Auto 模式依次尝试：

```text
OpenAI Chat Completions  /chat/completions
OpenAI Responses         /responses
```

成功后，本 Run 后续固定使用同一个协议，避免不同 Case 走不同 API 形状。

## 6. 程序验收原则

以下项目全部由程序判定：

```text
固定字符串
JSON 字段
工具名和工具参数
文件存在性
文件内容 sentinel
测试命令退出码
ffprobe 媒体元数据
Context sentinel
```

Candidate Model 自己说“已完成”“测试通过”不计分。

## 7. Context 测试

当前版本属于“估算 Token 长度的 Context recall”。生成大量 filler，把唯一 sentinel 放在约 72% 位置，再要求模型只返回 sentinel。

Full 默认目标：

```text
8K
16K
32K
64K
96K
128K
```

如果填写：

```text
Declared Context = 65536
```

系统不会主动跑 96K/128K。

注意：不同 tokenizer 下字符数到 Token 数的换算不是精确值，所以报告里使用 `estimatedTokens`，不能把它冒充成精确 tokenizer 计数。

## 8. DSH Agent 文件交付 Case

系统创建全新：

```text
workspaces/dsh-agent-file/
dsh-home/dsh-agent-file/
session id
```

Agent 被要求生成：

```text
deliverables/result.md
deliverables/diagram.svg
```

外部验收：

```text
Markdown 必须有指定 sentinel
SVG 必须能识别 <svg>
SVG 必须包含指定文字
```

通过后 Artifact 被复制进历史 Run。

## 9. DSH Agent Recovery Case

系统故意创建错误代码：

```text
calc.py
```

以及不可修改的：

```text
test_calc.py
```

Agent 必须自己定位、修改、运行测试，并创建修复说明。

Agent 结束后，Evaluator 再独立运行：

```bash
python3 test_calc.py
```

只有外部重跑成功才 PASS。

## 10. 视频交付 Case

Full 且 Host 存在 ffmpeg 时：

Agent 被要求生成：

```text
deliverables/model-eval-427.mp4
deliverables/media.md
```

外部使用：

```bash
ffprobe
```

检查：

```text
存在 video stream
时长 >= 1 秒
宽 >= 320
高 >= 180
说明文档 sentinel 正确
```

通过后 MP4 被复制到 Artifact 历史目录，HTML 报告使用 `<video controls>` + Range 直接播放。

## 11. 如何读报告

不要只看一个总通过率。

优先查看：

```text
agent
recovery
context
artifact
```

然后再看：

```text
instruction
tool
performance
```

`Skipped` 不进入分母。常见原因：

```text
DSH_SDK_UNAVAILABLE
ENVIRONMENT_CAPABILITY_MISSING
协议尚未支持该测试类型
```

## 12. 历史 Run

默认保存：

```text
$DSH_HOME/model-eval/<RUN_ID>/
```

一个 Run 不覆盖另一个 Run。

要复盘某个失败 Case，至少保留：

```text
run.json
report.html
workspaces/<CASE_ID>/
dsh-home/<CASE_ID>/
artifacts/<CASE_ID>/
```

## 13. 什么时候用哪档

### Smoke

适合：

```text
新 API 刚启动
改完反代
改完 OpenAI 兼容层
确认模型没有空回复
```

### Standard

适合：

```text
换量化
换模型
换 Provider
日常比较两套 endpoint
```

### Full

适合：

```text
准备换生产模型
修改推理 Runtime
修改上下文实现
准备让 DSH 无人值守跑长任务
```

## 14. 回归测试 SOP

真实业务遇到模型错误后，不要只修当次任务。

把问题压缩为：

```text
输入 workspace
任务描述
hidden evaluator
预算
期望产物
```

加入后续 Case Registry。

同一个 Bug 第二次出现，说明评测题库没有把生产教训固化下来。

## 15. 目前 0.1.0 的边界

已经是真实可运行引擎，但还没有完成最终规划中的所有项：

```text
Context compaction 专项
Session resume 专项
Vision 图片输入专项
3x/5x 稳定性重复
精确 streaming TTFT
Baseline 自动 diff UI
自定义 Case 包 GUI
```

这些能力按统一 Case 生命周期继续加，不需要推翻当前架构。
