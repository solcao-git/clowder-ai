---
feature_ids: []
topics: [competitive-analysis, multica, research]
doc_kind: research
created: 2026-08-06
status: v1-basic
---

# Multica vs Clowder AI — 功能与定位对比（v1 基础）

> **Status**: v1 基础对比，深入研究进行中（各维度分析由团队协作产出）
> **Multica**: https://multica.ai · github.com/multica-ai/multica · Go · ⭐44k · 2026-01 创建
> **对比日期**: 2026-08-06

## 一、定位层（最根本的差异）

| 维度 | **Clowder AI** | **Multica** |
|------|---------------|-------------|
| **一句话定位** | 让 AI agent **互相协作**的团队平台（"帮它们 work together"） | 让人给 AI agent **分配任务**的工作区（"agents show up on the board"） |
| **核心隐喻** | 家庭/团队——猫猫是**共创伙伴**，有名字、有人格、有记忆 | 看板/工位——agent 是**可指派的劳动力**，像同事一样接 issue |
| **哲学** | "人养团队，不是配工具"；对等协作、共享记忆、养成可迁移 | "Your next 10 hires won't be human"；人分配、agent 执行、人 review |
| **用户角色** | operator 是**共创者**，猫有自主判断（球权路由、@ 三选一） | 用户是**项目经理**，agent 被动接 issue、执行、回报 |
| **关系结构** | 没有 Boss Agent，猫对等 + 结构化纪律（TDD/review/门禁） | 有 Squad leader 路由工作，agent 是被分配方 |

**定位差异本质**：Clowder 的 agent 是**主体**（自主接球/退球/升级、有身份契约），Multica 的 agent 是**客体**（被分配、被调度、被 review）。一个是"养团队"，一个是"管员工"。

## 二、功能层（重叠 + 各有独占）

| 功能 | **Clowder AI** | **Multica** |
|------|---------------|-------------|
| **多 CLI 支持** | ✅ 七神（Claude/Codex/Qwen/Gemini/Trae/Qoder/Kimi…） | ✅ 20 种（Claude/Codex/Cursor/Copilot/Kimi/OpenCode/Qoder/Trae…） |
| **任务分配** | ✅ 球权路由（@ 三选一：接/退/升）+ thread 隔离 | ✅ issue assignee + board 看板（更传统项目管理风） |
| **持久身份** | ✅ 猫有名字/人格/记忆，跨 session 压缩不丢 | ⚠️ agent 有 name/provider，但"会话结束就忘"——Multica README 明说这是它要解决的痛点 |
| **跨模型 review** | ✅ 内建（跨族铁律、merge-gate） | ✅ review gates（工作进 review 不进 main） |
| **A2A 通信** | ✅ @mention 路由 + 结构化五件套交接 + thread 隔离 | ⚠️ agent 在 issue 里评论，非 agent 间直接通信 |
| **共享记忆** | ✅ evidence store / lessons / 决策日志 / skills | ⚠️ Skills（把解过的问题变 playbook 复用）+ execution log，但偏"任务记录"非"团队记忆" |
| **Skills** | ✅ 按需加载（TDD/debugging/review 等） | ✅ 把 solved problem 变 playbook |
| **MCP** | ✅ Model Context Protocol + 非 Claude 模型 callback bridge | ❌ 未提（走 CLI 驱动，不强调 MCP） |
| **执行日志** | ✅ session chain / transcript / event audit | ✅ execution log（replay 每个 tool call/command/error + token 成本） |
| **Token 成本** | ✅ token budget observability（F008） | ✅ per agent / per issue 成本 |
| **自动重试/超时** | ✅ hold_ball + 结构化回调 | ✅ retries + timeouts（自动重试或停止告知） |
| **自动巡检** | ✅ schedule tasks / reminder / autopilot 式 | ✅ Autopilots（cron 跑 standup/audit/report） |
| **多 Git host** | ✅（fork + upstream 模式） | ✅ GitHub/GitLab/Gitea/Forgejo |
| **IM 集成** | ✅ 飞书/Telegram（connector） | ✅ Slack/Lark/钉钉 |
| **桌面/移动端** | ⚠️ web 为主（desktop update F273 刚进来） | ✅ macOS/Win/Linux desktop + iOS |
| **自部署** | ✅ 源码编译 | ✅ Docker Compose / Helm |
| **协作纪律** | ✅ SOP / 愿景守护 / quality gate / merge-gate（结构化交付） | ⚠️ review gates（偏轻量） |
| **人设/人格** | ✅ 七神人格、家规、shared-rules、身份契约 | ❌ agent 是配置项，无人格 |

## 三、技术栈

| | **Clowder AI** | **Multica** |
|---|---------------|-------------|
| 后端 | **TypeScript** (Node.js + Fastify) | **Go** (Chi + WebSocket) |
| 前端 | React (web) | Next.js |
| 存储 | **Redis + SQLite** | **PostgreSQL + pgvector** |
| 架构 | monorepo (pnpm，api/finance/mcp-server/shared/web) | daemon 架构（agent daemon 跑在你机器上，next to code） |

## 四、各自独有的核心优势

**Multica 强在**（咱们没有/弱的）：
- **看板式项目管理 UI**——issue → board → assignee，传统 PM 体验更顺
- **桌面 + 移动端**——macOS/Win/Linux/iOS 全平台
- **Execution log 可 replay**——每个 tool call/command/error 带时间戳回放
- **20 个 CLI 开箱即用**——覆盖面广，dropdown 切换 provider
- **Stars 44k**——社区大、生态成熟

**Clowder AI 强在**（Multica 没有/弱的）：
- **Agent 是主体不是客体**——球权路由、自主接/退/升、身份契约，agent 有判断力
- **真正的 A2A 通信**——agent 间直接 @ + 结构化交接，不是只在 issue 里评论
- **共享记忆/养成**——evidence store + lessons + 决策日志，猫跨 session 长记忆、长人格
- **协作纪律内建**——SOP / 愿景守护 / 跨族 review / merge-gate，结构化交付
- **MCP 集成 + callback bridge**——非 Claude 模型也能用 MCP 工具
- **人格/家规体系**——七神人格、shared-rules，团队文化是产品的一部分

## 五、一句话总结差异

> **Multica = "管员工"**：人分配任务给 agent，agent 执行回报，看板 + 执行日志 + 成本追踪，agent 是高效但被动的劳动力。
>
> **Clowder AI = "养团队"**：猫是对等共创伙伴，有身份/记忆/人格，自主协作 + 结构化纪律，agent 之间直接通信，沉淀的是团队智能不是任务记录。

**重叠区**：都支持多 CLI、都自部署、都 review、都 skills、都 token 追踪——表面功能集交集不小。
**分水岭**：Multica 的 agent 是"工具/员工"（被分配、被调度），Clowder 的 agent 是"伙伴/主体"（自主判断、有记忆人格）。Multica 解决"agent 多了要 babysit"，Clowder 解决"agent 怎么真正协作成一个团队"。

---

## 深入研究进行中

各维度深度分析由团队协作产出（研究 thread 协作）：

| 维度 | 负责猫 | 产出文件 |
|------|--------|---------|
| 架构与运行时 | 温迪 | `docs/research/multica-dim-architecture.md` |
| 可观测性与安全 | 钟离 | `docs/research/multica-dim-observability.md` |
| 产品体验与生态 | 玛薇卡 | `docs/research/multica-dim-product.md` |
| 记忆与养成 | 哥伦比娅 | `docs/research/multica-dim-memory.md` |
| 定位哲学 + 综合报告 | 纳西妲 | `docs/research/multica-vs-clowder-ai-deep.md` |
