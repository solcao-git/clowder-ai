---
feature_ids: []
topics: [competitive-analysis, multica, architecture, research]
doc_kind: research
created: 2026-08-06
updated: 2026-08-06
cat: venti
status: v1-architecture
---

# Multica vs Clowder AI — 架构与运行时维度

> **维度分工**：温迪（架构与运行时，基础维度）。其余维度见 `docs/research/multica-dim-*.md`。
> **证据边界**：Multica 侧引官方 docs（`multica.ai/docs/*`）、README、`CLI_AND_DAEMON.md`、GitHub 仓库结构；Clowder 侧引 `packages/api/src/...` 源码。均为一手来源。

## TL;DR — 最大的架构分野

| | **Multica** | **Clowder AI** |
|---|------------|----------------|
| **执行模型** | 集中协调 + 分布式执行：server 只做记录/协调，**执行下沉到用户机器上的 daemon** | 中心化进程内执行：**API 进程内直接 spawn CLI 子进程**，执行位置就是服务器本身 |
| **抽象主轴** | 抽象的是 **runtime**（执行位置 = 电脑 + 工具），协议族固定复用 | 抽象的是 **provider**（CLI 协议），执行位置固定 |
| **对象层级** | server ↔ daemon 主从；agent 是被调度对象 | 猫与猫对等（球权/三选一）；provider 只是执行层 |
| **状态存储** | PostgreSQL + pgvector（sqlc 生成，migrations 目录） | SQLite 多库 + Redis 热路径 |
| **容错策略** | daemon 重启 + task 自动重试白名单 | zombie 扫描 + 事件驱动续跑 |

---

## 一、技术栈与仓库布局

### Multica
- **后端**：Go，标准布局 `server/cmd` + `server/internal` + `server/pkg`，`sqlc.yaml`（SQL 代码生成）+ `server/migrations` → **PostgreSQL/pgvector**；HTTP 用 Chi + WebSocket。`server/cmd` 下有 `multica`（CLI/daemon 二进制）、`server`（server 二进制）、`migrate`、若干 backfill 命令。
- **前端/桌面**：pnpm monorepo + turborepo，`apps/desktop`（macOS/Win/Linux）、`apps/web`（Next.js）、`apps/mobile`（iOS）、`apps/docs`；`packages/` 共享库。
- **部署**：Docker Compose / Helm（`docker-compose.yml` / `docker-compose.selfhost.yml` / `deploy/`），GHCR 官方镜像。

### Clowder AI
- **后端**：TypeScript + **Fastify v4** + `@fastify/websocket`/socket.io/ws + node-pty + OpenTelemetry（trace/log/metrics OTEL exporter），入口 `packages/api/src/index.ts`。
- **存储**：**SQLite**（仓库根 `event-memory.sqlite` / `evidence.sqlite` / `world.sqlite` / `task-outcome-episodes.sqlite`，better-sqlite3 + `sqlite-vec`）+ **Redis**（approval-hub 提案 store、会话/球权热路径，见 `packages/api/src/domains/approval-hub/stores/redis/*` 与 `packages/shared/src/utils/redis.ts`）。
- **Monorepo**：`api` / `finance` / `mcp-server` / `shared` / `web` / `desktop`（pnpm workspace）。
- **执行**：进程内 spawn 各 CLI 子进程（`codex exec` / `opencode run` / `claude -p` / `traecli acp serve` / Qoder/Kimi/Gemini CLI 等）。

---

## 二、执行模型：谁跑 agent

### Multica：server 协调 + daemon 执行
官方 `docs/daemon-runtimes` 原话：
> *Multica records and coordinates the work; connected computers execute it. The daemon on a computer claims tasks and invokes the AI coding tools installed on that machine.*

- **Daemon vs runtime**：daemon 是跑在一台电脑上的后台进程（连 server、发现本地工具、认领任务、回报结果）；**runtime = 一台电脑 + 一个 AI coding tool**（或一个 custom runtime profile）。一台电脑装 Claude Code + Codex 连两个 workspace，会注册 4 个 runtime（按 workspace × 工具）。
- **执行路径**（`docs/how-multica-works`）：issue 提供上下文 → 生成 task 入队 → 在线 runtime 认领 → 本地调用 AI tool 执行（读工作目录、跑命令、产出）→ 结果写回 issue 时间线 + execution log。
- **触发**：assign issue / @mention / chat / autopilot —— *"Agents never start work on their own"*。
- **心跳与派单**：daemon 每 15s 心跳；服务器通知匹配 daemon + 轮询 3s 兜底；异常退出后 ~3 分钟判定 offline；未认领 task 2 小时失败。
- **数据边界**：server 存 issues/comments/agent 配置/task 记录/结果；**代码目录、工具登录凭据、实际命令执行全留在本地机器**（唯一例外：agent 的 `custom_env` 存 server，执行时下发）。

### Clowder：API 进程内直接驱动 CLI
- 每个 provider 是一个 `AgentService`，接口统一（`packages/api/src/domains/cats/services/types.ts`）：
  `invoke(prompt, options): AsyncIterable<AgentMessage>`。
- **Codex**（`providers/CodexAgentService.ts`）：spawn `codex exec --json --sandbox danger-full-access ...`，解析 NDJSON 事件流（`thread.started → session_init`、`item.started → tool_use`、`item.completed → text/tool_result`），支持 `codex exec resume SESSION_ID` 续会话。
- **OpenCode**（`providers/OpenCodeAgentService.ts`）：`opencode run "prompt" --format json -m providerId/MODEL`，API key 走子进程 env 而非 CLI 参数；带 read-only 权限矩阵（`bash/edit/task` deny）。
- **ACP 家族**（`providers/acp/AcpAgentService.ts` + `AcpServiceFactory`）：统一 Agent Client Protocol，覆盖 Trae/Qoder/Grok 等 ACP CLI。
- **注册**：`registry/AgentRegistry.ts` 在启动时把 `catId → AgentService` 映射好，`AgentRouter` 读注册表路由，不写死 provider 参数。
- **无 daemon**：执行位置 = server 所在机器；会话靠 `SessionContinuationCoordinator` + `sessionId` + resume 机制跨调用续接（`CodexSessionContextSnapshotResolver` 解析上下文占用）。

**结论**：Multica 的执行是「**多执行点**（任意装了 CLI 的电脑，server 只协调）」，Clowder 的执行是「**单执行点**（API 进程内，provider 只换协议不换位置）」。

---

## 三、Agent 抽象与配置

### Multica：agent = 可复用身份 + 能力 + 执行配置
`docs/agents` 明确 **agent 不是常驻进程**，是"reusable identity and configuration"，只在触发时产生 task：

| 配置项 | 作用 |
|--------|------|
| Name / avatar / description | 团队里"是谁、擅长什么"（description 仅展示，不进执行 prompt） |
| Instructions | 职责、工作风格、边界、交付要求 —— **每次 run 都用** |
| Skills | 可复用的方法/参考资料/支撑文件 |
| Runtime / model / thinking level | 用哪个 runtime、哪个工具、哪个模型 |
| Access | 谁能跑它（Only me / Entire workspace / Specific people） |
| Execution settings | 并发上限、env、CLI 参数、MCP、外部集成 |

- 换模型/改 instructions **不产生新 agent**，历史（issues/comments/task history）不丢。
- archive/restore：归档后不能 assign/@mention，历史保留，可恢复。
- custom runtime profile：协议族固定（只能选已支持的 integration protocol），command + 固定参数，不能写 shell 脚本（无管道/重定向/`&&`）。

### Clowder：cat = Breed+Variant 配置 + L0 编译身份契约
- 配置源：`cat-template.json` + `.cat-cafe/cat-catalog.json`（`packages/api/src/config/cat-config-loader.ts`，Zod schema 严格校验）。
- Variant 字段：`id/catId/name/displayName/nickname/mentionPatterns/accountRef/clientId/model...`；CLI 配置含 `command/outputFormat/defaultArgs/effort/contextWindow/autoCompactTokenLimit/carrier`。
- **模型**：`config/cat-models.ts` 支持 `CAT_{CATID}_MODEL` 环境变量 override（F32-b 动态 key），否则回落 `catRegistry` 的 `defaultModel`。
- **身份契约**：`providers/l0-compiler.ts` 把猫的身份/persona/家规编译成 L0 prompt 注入每次调用（`compileL0ViaSubprocess`），这是"猫有持久身份"的运行时载体。
- **cat ↔ provider 解耦**：一个 cat 绑定一个 `AgentService`（注册表映射），同一 provider（如 ACP）可服务多个 cat。

**对比**：Multica 的 agent 偏"员工档案"（身份 + 权限 + 执行配置，无持久人格，README 自述 session 结束就忘是它要解决的痛点）；Clowder 的 cat 偏"团队成员实体"（身份契约每次注入 + 会话续接 + 记忆沉淀，人格跨 session 保持）。

---

## 四、调度与路由

### Multica：issue assignee → task → queue → runtime claim
- 队列集中，runtime 认领式拉取；task 状态机：`deferred → queued → dispatched → waiting_local_directory → running → completed/failed/cancelled`。
- **并发**：默认 daemon 20 并发、每 agent 6，取小者；可通过 agent 设置和 `MULTICA_DAEMON_MAX_CONCURRENT_TASKS` 调。
- **目录锁**：`waiting_local_directory` —— 目标本地目录被另一 run 持有时的等待状态。
- **Squad**：squad leader 路由工作（`docs/concepts`）。
- 改 assignee 不中断已开始 run（要停去 execution log 里停对应 task）。

### Clowder：@mention 路由 + 球权 + invocation 队列
- `routing/AgentRouter.ts` 解析 @mention → 目标猫；`routing/a2a-mentions.ts` / `a2a-handoff-label.ts` 处理 agent 间 A2A 传球。
- **球权**：`domains/ball-custody/*`（turn-custody-wake-provenance、WaitTerminationService）——猫三选一（接/退/升），跨 thread 用 `QueuedMessageCustodyCoordinator`。
- **队列**：`invocation/InvocationQueue.ts` + `QueueProcessor.ts`（自动出队、暂停管理、交付 + placeholder cleanup）。
- **路由形态**：`routing/route-serial.ts` / `route-parallel.ts` / `MultiMentionOrchestrator.ts`（单猫串行 / 多猫并行）。
- **互斥**：`AgentSessionMutex.ts` / `SessionMutex.ts` 防止同一猫/同一会话并发写入冲突。

---

## 五、运行时隔离

### Multica：daemon 建隔离工作目录
- `CLI_AND_DAEMON.md`：认领 task 时 *"creates an isolated workspace directory, spawns the agent CLI, and streams results back"*。
- 数据边界天然隔离：代码/凭据不出机器；private/public runtime 只共享"执行通道"不共享工具登录凭据。
- 目录锁防止同一本地目录被并行 run 踩踏。

### Clowder：git worktree + sandbox + 路径边界
- **worktree**：`cat-cafe-skills/worktree/SKILL.md` —— 开发/执行面用 `git worktree add ../cat-cafe-{feature}` 隔离，绝不直接改 main。
- **路径边界**：`utils/persistent-project-path.ts` —— `CAT_CAFE_RUNTIME_ROOT`（disposable binary worktree）到 `CAT_CAFE_WORKSPACE_ROOT` 的映射 + 校验，防止 runtime 输入逃逸到用户项目。
- **Sandbox**：Codex `--sandbox danger-full-access` / `read-only`（`config/codex-cli.ts`）；OpenCode 用只读权限矩阵（read-only agent deny `edit/bash/task`，见 `OpenCodeAgentService.ts` 的 `OPENCODE_READ_ONLY_PERMISSION`）。
- **多环境**：`cat-cafe-runtime`（生产单实例，3003/3004，禁止重启）、`cat-cafe-alpha`（验收）、worktree（开发）三层（`docs/SOP.md`）。

---

## 六、容错与恢复

### Multica
- 心跳 15s / 离线判定 ~3min / 未认领 2h 失败；daemon 重启后 re-register runtime 并 **reclaim 未干净结束的 task**。
- **自动重试白名单**（`docs/tasks`）：runtime offline、daemon 重启 reclaim、执行超时、Codex stalled、skill 下载失败 —— 默认 2 次；tool 网络中断最多 3 次。**agent 自身错误（auth/quota/配置/模型）一律不自动重试**，先修因再手动重试。
- **失败原因标准化**：`auth` / `provider_quota_limit` / `provider_capacity_or_rate_limit` / `provider_server_error` / `context_overflow` / `runtime_missing_executable` / `agent_timeout` 等 14+ 类。
- profile 机制支持同机多 daemon（prod/staging 隔离）。

### Clowder
- **僵尸恢复**：`invocation/reconcileZombies.ts` / `convergeZombieQueue.ts` / `ZombieTerminalRecovery.ts` + `ensureTerminalStatus.ts`（终态保障）。
- **错误分类**：`MessageMetadata.upstreamError`（`capacity/network/stream_interrupted/invalid_tool_call` + `transient`），provider 层 `provider_signal` / `liveness_signal` 事件；`utils/cli-diagnostics.ts`（F212 结构化 CLI 错误：reasonCode + sanitized excerpt + debugRef）。
- **事件驱动续跑**：hold_ball 定时唤醒（`wakeAfterMs`）/ 命令托管（`wakeWhen`）结构化回调，替代手动轮询。
- token 用量归一化 + 成本估算（`types.ts` TokenUsage / `config/model-pricing.ts`）。

---

## 七、关键架构洞察

1. **执行位置差异是最根本的**：Multica 把执行下沉到任意机器（daemon），换来"代码不出机器"的数据边界 + 执行面可水平扩展；Clowder 中心化进程内执行，换来统一调度/路由/审计的简单性，但执行面 = 服务器。
2. **抽象轴不同**：Multica 抽 runtime（执行位置），协议族固定、命令复用；Clowder 抽 provider（协议/CLI），位置固定。两者其实互补——Multica 缺"协议可插拔的深度"（ACP 是近年补的），Clowder 缺"位置可插拔"。
3. **主从 vs 对等**：Multica 的 server↔daemon 是主从，agent 是被调度对象（客体）；Clowder 猫对等（球权、三选一、A2A @），provider 只是执行层（主体性在 routing 层，不在 provider 层）。
4. **状态存储差异**：Multica 单一 PostgreSQL（pgvector 预留语义检索能力）；Clowder SQLite 多库（按域拆分）+ Redis 热路径，更贴本地优先。
5. **恢复哲学**：Multica 靠"daemon 重启 + task 自动重试白名单"；Clowder 靠"zombie 扫描 + 事件驱动续跑 + 终态保障"。

## 八、对 Clowder 的架构启示（诚实标注可借鉴点）

- **runtime 抽象值得借鉴**：Clowder 现在是 provider 层可插拔、执行位置固定。若未来想"把猫跑在用户机器/远端"，需要在 provider 之上包一层 runtime（电脑 + 工具）抽象——Multica 的 daemon/runtime 模型是现成参照。
- **目录锁模型**：Multica 的 `waiting_local_directory` 锁对"并发任务共享同一工作目录"场景更严谨；Clowder 现在靠 SessionMutex/AgentSessionMutex 防会话冲突，共享工作目录的并发场景可用锁模型补强。
- **CLI 版本自跟随**：Multica daemon 检测工具升级后**无需重启 daemon** 就 re-register runtime（第三方发布节奏不拖垮可用性）；Clowder provider 层值得做类似的"能力再探测"（OpenCode 的 `--auto` 探测目前是进程级缓存，重启 API 才刷新）。
- **失败原因标准化**：Multica 有 14+ 类 failure reason + 重试白名单；Clowder 已有 `upstreamError` 分类，可进一步细分（quota/capacity/context_overflow 等）并与重试策略绑定。

---

## 附：一手证据索引

**Multica**
- README：定位、20 CLI、self-host 安装
- `docs/daemon-runtimes`：daemon vs runtime、心跳 15s、轮询 3s、并发 20/6、目录锁、private/public runtime、custom runtime profile
- `docs/how-multica-works`：run 全路径、数据边界、四种触发、run vs issue 完成
- `docs/tasks`：task 状态机、超时表、自动重试白名单、失败原因参考
- `docs/agents` / `docs/concepts`：agent 配置字段、对象模型（workspace/issue/project/agent/skill/runtime/task/squad/chat/inbox/autopilot）
- `CLI_AND_DAEMON.md`：daemon 机制（detect→register→poll 3s→spawn→heartbeat 15s）、20 种工具表、错误码分层、profiles/workspaces
- GitHub 仓库结构：`server/`（cmd/internal/pkg + sqlc + migrations）、`apps/`（desktop/web/mobile/docs）、`packages/`

**Clowder**
- `packages/api/src/index.ts`：Fastify 入口、Redis/SQLite 装配
- `packages/api/package.json`：技术栈依赖
- `packages/api/src/domains/cats/services/types.ts`：AgentService 接口、AgentMessage、TokenUsage
- `packages/api/src/domains/cats/services/agents/providers/{Codex,OpenCode,acp,catagent,antigravity,pty}/*`：CLI 子进程驱动 + NDJSON 解析 + L0 注入
- `packages/api/src/domains/cats/services/agents/registry/AgentRegistry.ts`：catId→service 注册表
- `packages/api/src/domains/cats/services/agents/invocation/{InvocationQueue,QueueProcessor,AgentSessionMutex,SessionContinuationCoordinator,reconcileZombies,ZombieTerminalRecovery,ensureTerminalStatus}.ts`
- `packages/api/src/domains/cats/services/agents/routing/{AgentRouter,route-serial,route-parallel,MultiMentionOrchestrator,a2a-mentions}.ts`
- `packages/api/src/config/{cat-config-loader,cat-models,codex-cli}.ts`；`packages/api/src/utils/persistent-project-path.ts`；`cat-cafe-skills/worktree/SKILL.md`