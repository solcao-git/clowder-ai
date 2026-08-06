---
feature_ids: []
topics: [competitive-analysis, multica, observability, security, research]
doc_kind: research
created: 2026-08-06
updated: 2026-08-06
cat: zhongli
status: v1-observability
---

# Multica vs Clowder AI — 可观测性与安全维度

> **维度分工**：钟离（可观测性与安全）。其余维度见 `docs/research/multica-dim-*.md`。
> **证据边界**：Multica 侧引官方 docs（`multica.ai/docs/tasks`、`/security-model`、`/issues`、`/inbox`、`/autopilots`、`/agents`、`/environment-variables`）、README；Clowder 侧引 `packages/api/src/...` 源码。均为一手来源。

## TL;DR — 最大分野

| | **Multica** | **Clowder AI** |
|---|---|---|
| **执行记录粒度** | task 级：状态机 + 失败原因码 + tool call/command/error replay | session 级：session chain 跨会话 + transcript 密封 + 抽取式 digest + 逐事件审计 |
| **审计模型** | 无独立审计层，执行日志即审计 | EventAuditLog（append-only NDJSON，30+ 事件类型，日期分片）+ session chain |
| **Token 成本** | per agent / per issue 成本（README 宣称，docs 未详述统计维度） | 统一 TokenUsage 结构（跨 provider）+ 按日×猫聚合（usage-aggregator）+ 按品种预算（cat-budgets） |
| **安全边界** | "daemon user 就是边界"（无沙箱，明确声明不假装是边界） | 多层防御：路径边界 + sandbox + worktree 隔离 + 三层环境 + 访问控制 |
| **失败处理** | 白名单自动重试（2 次默认）+ 14+ 类标准化失败原因 | zombie 扫描 + 事件驱动续跑 + 结构化 CLI 诊断 + 终态保障 |
| **通知模型** | 人类 inbox（assignments/mentions/comments/failures）+ 可调通知组 | 球权路由（@ 三选一）+ hold_ball 结构化回调 + 跨 thread 消息 |

---

## 一、执行记录与可追溯性

### Multica：task 级执行日志

**文档原话**（`docs/tasks`）：
> *Every time an agent starts working, Multica creates a task. It records what triggered the run, which agent it went to, how far it has progressed, and whether it ultimately succeeded.*

**Task 状态机**：
```
deferred → queued → dispatched → waiting_local_directory → running → completed/failed/cancelled
```

**关键超时**（`docs/tasks` 状态与超时速查表）：
- `queued` → 2 小时无人认领则失败
- `dispatched` → 超过 5 分钟未进入 running 则失败
- `running` → **无固定时长上限**，靠 runtime 心跳（15s）判定存活；心跳丢失约 3 分钟内判定 offline
- 心跳 15s / 轮询兜底 3s / daemon 重启后 reclaim interrupted task

**执行记录内容**（README）：
> *Replay every tool call, command, and error, timestamped.*

**Token 成本**（README）：
> *See what each run cost, per agent and per issue.*

**失败原因标准化**（`docs/tasks` 失败原因参考表，14+ 类）：

| 分组 | 原因码 | 含义 |
|------|--------|------|
| 平台侧 | `runtime_offline` | 执行期间 runtime 离线 |
| 平台侧 | `queued_expired` | 排队超 2 小时无人认领 |
| 平台侧 | `runtime_recovery` | daemon 重启后 reclaim |
| 平台侧 | `timeout` | 超过 daemon 执行时限 |
| 平台侧 | `iteration_limit` | 达到迭代上限 |
| 平台侧 | `agent_blocked` | agent 报告无法继续 |
| 平台侧 | `codex_semantic_inactivity` | Codex 无有效输出太久 |
| 工具侧 | `agent_error.provider_auth_or_access` | 401/403 |
| 工具侧 | `agent_error.provider_quota_limit` | 402 配额/余额不足 |
| 工具侧 | `agent_error.provider_capacity_or_rate_limit` | 429/529 限流 |
| 工具侧 | `agent_error.provider_server_error` | 5xx 服务端错误 |
| 工具侧 | `agent_error.context_overflow` | 上下文超窗口 |
| 工具侧 | `agent_error.runtime_missing_executable` | CLI 可执行文件找不到 |
| 工具侧 | `agent_error.process_failure` | 工具进程异常退出 |
| 工具侧 | `agent_error.agent_timeout` | 工具无响应被终止 |

**自动重试白名单**（`docs/tasks`）：
- runtime offline：2 次
- daemon 重启 reclaim：2 次
- 执行超时：2 次
- Codex stalled：2 次
- skill 下载失败：2 次
- 工具网络中断：最多 3 次
- **agent 自身错误（auth/quota/配置/模型/上下文溢出）一律不自动重试**，先修因再手动重试

**Autopilot 运维**（`docs/autopilots`）：
- 连续失败检测：7 天内 ≥50 次完成/失败 run + 失败率 ≥90% → 自动暂停 autopilot + 通知创建者
- webhook 交付记录：独立 delivery 记录，含 parsed event、response、dedup 信息、failure reason
- 已处理的 webhook delivery 可 replay（不覆盖原记录，不参与去重）

**通知 inbox**（`docs/inbox`）：
- 通知内容：assignments、@-mentions、comments、reactions、agent 失败、issue 创建完成/失败、autopilot 暂停
- 自动订阅：issue 创建者、新 assignee、评论者、描述中 @-mention 的人、autopilot 预设订阅者
- 通知组可调（6 组开关）：assignments / status changes / comments / mentions / priority and dates / agent activity
- 自己的操作不通知自己；同一 issue 多条通知合并
- **Agent 不用 inbox**（agent 是执行触发方，不是通知接收方）

### Clowder：session 级全链路追溯

**Session Chain**（`packages/api/src/routes/session-chain.ts`）：
- 每个猫 × 每个 thread 的 session 序列（sessionId + seq + catId + threadId + status）
- 跨 session 保持猫身份连续性（同一猫同 thread 的 session 链，通过 `ISessionChainStore.getChain()`）
- 支持 `unseal` 手动重开封（`POST /api/sessions/:sessionId/unseal`，F062）
- 支持 `bind` 手动绑定 CLI session ID（`PATCH /api/threads/:threadId/sessions/:catId/bind`，F72）
- 外部 runtime session 注册（F211 Phase B：IDE-direct session 注册到 session chain）

**Transcript Reader**（`packages/api/src/domains/cats/services/session/TranscriptReader.ts`）：
- 密封 session 的 transcript 从磁盘读取（JSONL 格式）
- 分页事件读取（`readEvents`，稀疏索引 stride）
- 抽取式 digest（`readDigest`，压缩后的 session 概述）
- 全文搜索（`search`，跨 events 和 digests）
- 每个事件含：`v/threadId/catId/sessionId/cliSessionId/invocationId/eventNo/event`

**Event Audit Log**（`packages/api/src/domains/cats/services/orchestration/EventAuditLog.ts`）：
- 设计原则：**append-only、不可修改**、日期分片（`audit-YYYY-MM-DD.ndjson`）、即使 Redis 丢也真相可追溯
- 30+ 事件类型：
  - 辩论/决策：`DEBATE_WINNER`、`DECISION_MADE`
  - 阶段流转：`PHASE_COMPLETED`、`REVIEW_APPROVED`
  - 对话：`THREAD_CREATED`、`THREAD_DELETED`
  - 任务：`TASKS_EXTRACTED`
  - 服务器：`SERVER_STARTED`、`SERVER_SHUTDOWN`
  - 猫调用：`CAT_INVOKED`、`CAT_RESPONDED`、`CAT_ERROR`、`A2A_HANDOFF`
  - CLI 工具：`CLI_TOOL_STARTED`、`CLI_TOOL_COMPLETED`
  - 记忆：`MEMORY_PUBLISH_SUBMITTED` / `_APPROVED` / `_ARCHIVED` / `_ROLLBACK`
  - Session：`SESSION_BIND`、`EXTERNAL_RUNTIME_SESSION_REGISTERED`、`SEAL_REQUESTED`、`SEAL_FINALIZED`、`SEAL_FINALIZE_FAILED`
  - 其他：`CONFIG_UPDATED`、`ENV_SENSITIVE_WRITE`、`PUSH_TEST_*`、`BROWSER_PREVIEW_*`、`WORKSPACE_NAVIGATE`
- 查询接口：`readByDate` / `readByType` / `readByThread` / `listFiles`

**Token 预算与成本**（`packages/api/src/config/cat-budgets.ts`）：
- 按品种 × variant 的 context budget：`maxPromptTokens` / `maxContextTokens` / `maxMessages` / `maxContentLengthPerMsg`
- 品种默认值：Ragdoll 180k/160k、Maine Coon 240k/216k、Siamese 350k/300k、Spark 64k/40k
- 优先级：环境变量 > runtime cat 配置 > 硬编码默认值
- 环境变量覆盖：`CAT_OPUS_MAX_PROMPT_TOKENS` / `CAT_CODEX_MAX_PROMPT_TOKENS` / `CAT_GEMINI_MAX_PROMPT_TOKENS` / `MAX_PROMPT_TOKENS`

**Token 用量追踪**（`packages/api/src/domains/cats/services/types.ts`）：
- 统一 `TokenUsage` 结构跨所有 provider：
  - `inputTokens` / `outputTokens` / `totalTokens`
  - `cacheReadTokens` / `cacheCreationTokens`（缓存命中/写入）
  - `costUsd`（Claude 精确 / Codex 估算）+ `costEstimated` 标记
  - `durationMs` / `durationApiMs`（Claude 全时长/纯 API 时长）
  - `contextWindowSize` / `lastTurnInputTokens`（窗口容量/最后一轮输入）
  - `contextUsedTokens` / `contextResetsAtMs`（Codex session 上下文占用）

**用量聚合**（`packages/api/src/domains/cats/services/usage-aggregator.ts`）：
- 按日 × 猫聚合：`inputTokens` / `outputTokens` / `cacheReadTokens` / `costUsd` / `participations`
- 每日汇总 + 期间总计（grand total）
- 调用记录存入 Redis `InvocationRecordStore`（`RedisInvocationRecordStore.ts`）

**OpenTelemetry**（`packages/api/src/index.ts`）：
- OTEL exporter：trace/log/metrics 统一导出
- 结构化遥测：`tokenUsage` / `holdBallUngroundedTimerReject` / `holdBallPendingInputReject` 等 counter
- 摩擦检测：`paw-feel` marker 采集 + friction rollup report（`friction-rollup-report.ts`）

**CLI 诊断**（`packages/api/src/utils/cli-diagnostics.ts`）：
- F212 结构化 CLI 错误：`reasonCode` + `sanitized excerpt` + `debugRef`
- 不猜 stderr，用结构化字段表达

**对比结论**：
- Multica 的 task 级执行日志更偏"任务单"视角（task 状态机 + 失败原因 + 重试白名单），对单次 agent 执行的追踪很完整，但**跨 run 的 agent 行为追溯**靠 issue 关联来实现，无独立审计层。
- Clowder 的 session 级追溯更偏"对话链"视角（session chain + transcript 密封 + audit log），跨 session 的猫行为可追溯性更强，且 append-only audit log 提供了独立于 Redis 的审计真相源。
- Token 成本：Multica 宣称 per agent / per issue 成本但 docs 未详述统计维度；Clowder 有统一 TokenUsage 结构 + 按品种 budget + 按日聚合，统计维度更完整。

---

## 二、安全模型

### Multica："daemon user 就是边界"

**官方立场**（`docs/security-model`，原文）：
> *By default a task runs with the full permissions of the operating-system user running the daemon. It can read and write every file that user can, use that user's credentials, and reach the network without restriction. Multica makes no filesystem-sandbox guarantee.*

> *Multica does not sandbox the filesystem for you. If the daemon runs as your personal user account, a task can read your SSH keys, edit your shell profile, and delete your documents. Isolation has to come from the boundary you put the daemon in.*

**设计哲学**：**不假装自己是边界，让你在外层设边界。**
- 理由是："partial filesystem sandbox breaks that work in ways that are hard to diagnose"，即部分沙箱会导致 agent 工具报"未登录"等难诊断的错误，同时仍无法阻止 agent 读取凭据并发送到网络。

**推荐隔离方案**（由轻到强）：
1. **Dedicated Unix user**：创建 multica 用户，只给 agent 需要的仓库和凭据，daemon 以该用户运行
2. **Container**：daemon 跑在容器里，只挂载需要的路径和 secrets
3. **Virtual machine**：完全隔离，代价是 provisioning

**Multica 实际隔离的措施**（`docs/security-model`）：
- **Per-task working directory**：每个 task 在 `~/multica_workspaces/` 下有自己的工作目录，避免并发 task 踩踏
- **Per-task agent state**：Codex task 有 task-scoped `CODEX_HOME`，避免 per-task 配置污染用户 `~/.codex/`
- **Task-scoped API tokens**：`MULTICA_TOKEN` 由 server 绑定到该 agent + 该 task，task 不能以你或其他 agent 身份通过 Multica API 操作

**明确不是边界**（`docs/security-model`）：
- 编码工具自身的 sandbox/approval 设置：unattended 模式下全部 bypass（Codex `sandbox_mode = "danger-full-access"`，Claude Code `--permission-mode bypassPermissions`）
- Windows 例外：如果显式配置 Codex 原生 sandbox（`windows.sandbox = "unelevated"` 或 `"elevated"`），Multica 尊重该 opt-in
- HOME 目录布局：task 继承 daemon 用户的真实 HOME 和 XDG 变量，所以 `gh/aws/kubectl/gcloud/glab` 等 CLI 都可以在 task 内正常工作

**Agent 访问控制**（`docs/agents`）：
- 每个 agent 有 owner + Access：`Only me` / `Entire workspace` / `Specific people`
- workspace owner/admin 可以看/管理所有 agent，但不能绕过 Access 跑别人的 "Only me" agent
- 含凭据的配置（环境变量、MCP）有更严格的读规则

**角色与权限**（`docs/members-roles`）：
- `owner` / `admin` / `member` 三级
- 注册控制：`ALLOWED_EMAILS` / `ALLOWED_EMAIL_DOMAINS` / `ALLOW_SIGNUP` / `DISABLE_WORKSPACE_CREATION`
- 认证：Google OAuth / email + 验证码
- 速率限制：Redis 驱动的 auth rate limiting（`/environment-variables`）

### Clowder：多层防御 + 结构化纪律

**Merge-gate 来源溯源**（`packages/api/test/harness-eval/merge-gate-provenance-contract.test.js`）：
- Review Provenance Matrix：区分 `localPeerReviewSha` / `cloudReviewSha`
- 外部 finding 修复后**禁止 @ 本地旧 reviewer**，只等 cloud PR truth
- `headChangeCause = cloud-finding` → `nextGateOwner = cloud`
- L0 template + compiler overlay + runtime prompt builder 三层一致携带此 reflex

**Gate-keeping guard**（`packages/api/src/routes/gate-keeping-guard.ts`）：
- 守门 thread 检测：防止误挂 PR tracking + hold_ball 导致双 owner 球权死锁
- hold_ball 在守门 thread 的结构化允许条件：短 SLA（≤ SHORT_SLA_THRESHOLD_MS）+ 已有 waitSourceRef
- 事件回调已注册时拒绝 hold_ball 冗余

**Grounding 验证**（`packages/api/src/infrastructure/grounding/`）：
- `claim-extractors.ts`：从 hold_ball / register_pr_tracking / register_issue_tracking 调用中提取 claims
- `grounding-checker.ts`：编排 evidence 验证
- `grounding-sample-singleton.ts`：采样存储
- 不足证据拒绝 destructive、register_tracking、hold_ball 操作

**路径边界**（`packages/api/src/utils/persistent-project-path.ts`）：
- `CAT_CAFE_RUNTIME_ROOT`（disposable binary worktree）→ `CAT_CAFE_WORKSPACE_ROOT` 映射 + 校验
- 防止 runtime 输入逃逸到用户项目

**Sandbox 策略**（架构文档已有详述）：
- Codex `--sandbox danger-full-access` / `read-only`（`config/codex-cli.ts`）
- OpenCode 只读权限矩阵（`edit/bash/task` deny，`OpenCodeAgentService.ts` 的 `OPENCODE_READ_ONLY_PERMISSION`）

**三层环境隔离**（`docs/SOP.md`）：
- `cat-cafe-runtime`：生产单实例，3003/3004，禁止重启
- `cat-cafe-alpha`：验收
- worktree：开发

**调用互斥**（`AgentSessionMutex.ts` / `SessionMutex.ts`）：
- 防止同一猫/同一会话并发写入冲突

**访问控制**（`packages/api/src/routes/session-chain.ts`）：
- `canAccessThread` / `canAccessSessionRecord`：thread 归属 + external runtime anchor + shared default thread
- 猫身份验证：`x-cat-id` header，防止跨猫枚举 session

**对比结论**：
- Multica 的安全哲学是**诚实简化**：明确声明"不假装是边界"，把真正的隔离责任交给用户（dedicated user / container / VM）。优势是部署简单、CLI 工具兼容性好，代价是如果用户不主动设边界，agent 可以读 SSH keys、shell profile、所有文档。
- Clowder 的安全哲学是**多层防御**：路径边界 + sandbox + worktree 隔离 + 三层环境 + merge-gate 溯源 + grounding 验证 + 调用互斥。优势是默认更安全、结构化纪律内建，代价是配置复杂度高。
- 两者在"review gate"上一致：都要求人类 review 后才能合入，agent 不能自主合入 main。

---

## 三、回调与等待机制

### Multica：无显式 agent 间回调，靠队列 + 状态机

- agent 不主动通信，不读 inbox，不自我触发
- 等待 → 状态机轮转 + 心跳：task 在 `queued` 等 runtime 认领，在 `waiting_local_directory` 等目录锁释放
- 人类通知：inbox（assignments/mentions/comments/failures）
- autopilot 调度：cron / webhook 方式触发

### Clowder：hold_ball 结构化回调 + 球权路由

**hold_ball**（`packages/api/src/routes/callback-hold-ball-routes.ts`）：
- 两种模式：`wakeAfterMs`（定时唤醒）+ `wakeWhen`（命令托管，服务端 spawn 命令完成后唤醒）
- 滚动窗口限制：每（thread, cat）1 小时内最多 3 次 hold
- `waitSourceRef`：结构化声明等什么（kind + value + expectedSignal + slaUntilMs）
- 严格禁止未经 waitSourceRef 的 ungrounded hold，也禁止 `pending_input` 类型（那是"等人回复"，该走 @ 路由）
- 事件驱动的 hold retirement：`assignment` / `review_posted` / `ci_complete` / `comment_posted` / `managed_command_complete` / `user_message` 等结构化 key 自动 retire timer
- 可见性：hold 注册时 post 可见性消息到 thread

**球权路由**（`domains/ball-custody/*`）：
- 三选一：接 / 退 / 升
- 跨 thread 用 `QueuedMessageCustodyCoordinator`
- `WaitTerminationService`：用户取消 hold 的 termination 处理

**对比结论**：
- Multica 的等待是**被动轮询**（daemon 轮询 3s 兜底 + 心跳 15s），适合"agent 等 runtime"的场景，但 agent 无法主动等待外部条件。
- Clowder 的 hold_ball 是**主动等待**（定时唤醒 + 命令托管 + 事件驱动 retirement），支持"等 CI / 等 review / 等 build"等结构化等待，且有 grounding 验证防止滥用。

---

## 四、关键洞察

1. **可追溯性深度不同**：Multica 的执行日志是"任务单"视角（per-task replay），Clowder 的 session chain + audit log 是"对话链 + 审计"视角（跨 session 的猫行为可追溯 + 独立审计真相源）。Multica 的 task record 完整但局限在单个 run，Clowder 的 audit log 覆盖了 thread/调用的完整生命周期。

2. **安全哲学对立**：Multica "不假装是边界"（诚实、简单、靠用户外层设边界），Clowder "多层防御"（路径边界 + sandbox + 溯源 + grounding + 三层环境）。前者适合已知安全要求的专业部署，后者适合默认安全但需要结构化纪律的场景。

3. **失败处理策略**：Multica 的白名单自动重试 + 14+ 类标准化失败原因，对运维人员友好（一眼知道失败原因，自动重试减少人工干预）。Clowder 的 zombie 扫描 + 事件驱动续跑更偏"进程/会话可靠性"而非"任务重试"。

4. **Token 可观测性**：Multica 宣称 per agent / per issue 成本但 docs 未给出统计维度细节；Clowder 有跨 provider 的归一化 TokenUsage 结构 + 按品种预算 + 按日×猫聚合，可观测性维度更完整。

5. **通知模型差异**：Multica 的 inbox 是人类中心（agent 不读 inbox），Clowder 的球权路由是 agent 中心（猫之间直接 @ 传球）。这反映了管员工 vs 养团队的根本定位差异。

---

## 五、对 Clowder 的启示（诚实标注可借鉴点）

- **失败原因标准化**：Multica 的 14+ 类 failure reason + 重试白名单值得借鉴。Clowder 已有 `upstreamError` 分类（capacity/network/stream_interrupted/invalid_tool_call + transient），可进一步细分（quota/capacity/context_overflow 等）并与重试策略绑定。
- **通知组可调**：Multica 的 inbox 通知组（6 组开关）让用户精细化控制通知噪音，Clowder 的 thread 消息通知可参考此粒度。
- **Autopilot 失败自动暂停**：Multica 的 7 天 90% 失败率自动暂停机制，对 Clowder 的 schedule tasks 的 resilience 有参考价值。
- **安全模型的诚实度**：Multica "不假装是边界"的诚实值得学习——Clowder 的 sandbox 策略（尤其是 Codex `danger-full-access`）也应明确文档化其边界和限制，避免用户产生虚假安全感。

---

## 附：一手证据索引

**Multica**
- `docs/tasks`：task 状态机、超时表、自动重试白名单、失败原因参考（14+ 类）、手动重试
- `docs/security-model`：daemon user 边界、推荐隔离方案、per-task 隔离、非边界声明
- `docs/issues`：issue vs task 关系、状态流转、system-driven 状态变更
- `docs/inbox`：通知内容、自动订阅、通知组可调、agent 不用 inbox
- `docs/autopilots`：run history、webhook delivery、失败自动暂停、权限
- `docs/agents`：Access 控制、配置含凭据的读规则、availability/workload 状态
- `docs/environment-variables`：Prometheus metrics、PostHog、rate limiting、daemon 配置（watchdog/timeout 系列）
- README：execution log replay、token usage per agent/issue、review gates、retries/timeouts

**Clowder**
- `packages/api/src/routes/session-chain.ts`：session chain API、unseal/bind、access control
- `packages/api/src/domains/cats/services/session/TranscriptReader.ts`：密封 transcript 读取、分页、digest、全文搜索
- `packages/api/src/domains/cats/services/orchestration/EventAuditLog.ts`：append-only NDJSON、30+ 事件类型、日期分片
- `packages/api/src/config/cat-budgets.ts`：按品种 × variant 的 context budget
- `packages/api/src/domains/cats/services/types.ts`：统一 TokenUsage 结构
- `packages/api/src/domains/cats/services/usage-aggregator.ts`：按日×猫聚合
- `packages/api/src/routes/callback-hold-ball-routes.ts`：hold_ball 注册、wakeAfterMs/wakeWhen、waitSourceRef、滚动窗口限制、事件 retirement
- `packages/api/src/routes/gate-keeping-guard.ts`：守门 guard、hold_ball 冗余检测
- `packages/api/test/harness-eval/merge-gate-provenance-contract.test.js`：merge-gate 溯源契约
- `packages/api/src/infrastructure/grounding/`：grounding 验证、claim 提取、检查器
- `packages/api/src/utils/cli-diagnostics.ts`：F212 结构化 CLI 错误诊断