# AI Data Server

Cloudflare Worker Cron Trigger 每 30 分钟触发一次 GitHub Actions `workflow_dispatch`，由 GitHub Actions 生成 X 榜单数据。每轮先请求 OpenRouter 一次；如果发生 HTTP、网络、超时、空响应、无效 JSON 或输出校验失败，再通过 NVIDIA MiniMax 请求一次。只有抓取、AI 聚类和本地校验全部成功时才发布新数据。

Worker 定时器代码位于 `worker/worker.js`。部署到 Cloudflare Worker 后，在 Worker 的 Settings → Triggers → Cron Triggers 中添加 `23,53 * * * *`；Cloudflare 使用 UTC 时间。Worker Secret 名称为 `GITHUB_AI_DATA_SERVER`，代码只通过 `env.GITHUB_AI_DATA_SERVER` 读取，不在仓库中保存 Secret。

OpenRouter 主请求固定使用免费模型 `minimax/minimax-m3:free`，不经过 `openrouter/free` 动态路由。该模型提供约 100 万 token 上下文；请求使用 `temperature: 1`、`top_p: 0.95` 和 32768 token 输出预算，并启用内部推理。`reasoning.exclude: true` 会隐藏推理文本，避免推理过程污染最终可解析内容。NVIDIA 兜底固定使用 `minimaxai/minimax-m3`，请求参数为 `temperature: 1`、`top_p: 0.95`、`max_tokens: 8192`、`stream: false`。两个供应商均通过本地严格校验保证输出结构；OpenRouter 成功时不会请求 NVIDIA，同一轮总 AI 请求数最多为 2。

> 注意：NVIDIA 模型页公告 `minimaxai/minimax-m3` 将于 2026-09-08 停止 API 支持。应在该日期前通过 `nvidia_fallback_model` 配置替换兜底模型，并同步更新允许参数。

程序兼容 SSE 流式响应和普通 JSON 响应，只在完整接收并通过校验后写入最终 JSON。GitHub Actions 日志以 `MODEL_OUTPUT_RAW` 事件完整记录模型最终可见输出并按 `chunk`/`chunks` 分块，方便诊断格式校验失败；庞大的 SSE 推理流只记录传输摘要，不记录完整 reasoning trace，也不会记录 API Key。最终 JSON 顶层的 `model_id` 和 `topic_meta.model` 会记录成功生成数据的模型。

OpenRouter 失败后才会启动 NVIDIA MiniMax。若 NVIDIA 也失败，整轮任务失败且不会覆盖上一次成功生成的榜单文件。

话题聚类只处理合并去重后按曝光量排序的前 200 条有效帖子：总量超过 200 条时舍弃其余帖子，不足 200 条时则全部提交。AI 优先把同一人物、公司、产品、争议、传闻或持续动态的报道与评论归入较集中的热点话题，本地程序将这些帖子中剩余的帖子保留为独立话题。第 200 条之后的帖子不提交给 AI，也不生成话题，但原始 `rate`/`views` 榜单仍会保留。最终排序始终先展示多帖话题，再展示独立话题；两类内部均按总曝光量降序排列。

## Repository secrets

- `XBANGDAN_API_URL`：包含 API Key 的完整上游 JSON URL。
- `NVIDIA_API_KEY`：一个或多个 NVIDIA API Key，每行一个。
- `OPENROUTER_API_KEY`：一个或多个 OpenRouter API Key，每行一个；每轮只使用其中一个 Key 发起一次请求。

这些值配置为 Repository Secrets，工作流只通过 `${{ secrets.* }}` 上下文读取。

不要把 Secret 写入 `config.json`、日志或提交记录。

## 超时与诊断

- OpenRouter 请求最多 20 分钟，不为 NVIDIA 兜底强制预留完整请求时间。
- NVIDIA MiniMax 请求最多 20 分钟，但仍受 AI 总预算剩余时间限制；若收到流式响应，连续 3 分钟没有数据时提前终止。
- AI 阶段内部总预算为 25 分钟；每轮最多请求 OpenRouter 和 NVIDIA 各一次。OpenRouter 若用满 20 分钟，NVIDIA 最多使用剩余约 5 分钟。
- GitHub Actions 单次任务最多运行 25 分钟；定时触发由 Cloudflare Worker 负责，GitHub Actions 保留 `workflow_dispatch` 供手动运行。
- 每次运行输出分阶段日志和 Job Summary；常规诊断日志限制为 64 KiB，`MODEL_OUTPUT_RAW` 完整输出不计入该额度，也不会写入榜单 JSON 或 Git 仓库。
- 每次运行还会上传保留 7 天的 `ai-model-output-<run>-<attempt>` Artifact；下载其中的 `ai_model_output.txt` 可按模型尝试查看脱敏请求（含提示词、帖子、参数和请求头）及可见输出，任务失败时也会上传。每次请求都对应一条响应记录；HTTP 错误、SSE 中途错误、超时或网络失败也会写入错误码、已接收的部分输出和原始错误响应。整个 Artifact 文件有 2 MiB 硬上限，超出时写入截断标记并停止追加。文件会标注 `finish_reason`、字符数和 API 是否因 token 上限截断。
- Artifact 写入前会检测并遮蔽配置中的实际 API Key、完整 `XBANGDAN_API_URL`、Bearer/token、`sk-`/`nvapi-` 等常见 Key，以及 URL 查询参数中的凭据；普通帖子 URL 保留。文件已加入 `.gitignore`，不会进入 `main`。
- Actions 日志包含模型请求体和最终可见输出，可能包含帖子正文、文章 ID、URL 等内容；API Key、Authorization 和 Repository Secret 始终脱敏。
- 日志还记录实际模型、结束原因、响应字节数、token 用量和有效话题数等元数据；失败时通过错误代码区分上游下载、AI 超时、流式响应、JSON 解析、输出校验和发布冲突。

## 数据地址

成功运行后，最新文件直接位于 `main` 分支：

```text
data/feed_complete.json
```

原始地址：

```text
https://raw.githubusercontent.com/ai-catcher/ai-data-server/main/data/feed_complete.json
```

每次成功运行都会使用当前完整文件树创建一个新的根提交，并安全覆盖 `main`。因此 `main` 始终只有一个可见提交，不保留榜单文件的提交历史。AI 或数据校验失败时不会更新 `main`。

最终 JSON 顶层的 `generated_at` 是本次成功生成的 UTC ISO 8601 时间戳，可供前端判断数据是否过期。

## 手动运行

在仓库的 Actions 页面选择 `Update ranking data`，然后点击 `Run workflow`。正式数据依赖 Repository Secrets，不要在命令行中输出这些值。

##
