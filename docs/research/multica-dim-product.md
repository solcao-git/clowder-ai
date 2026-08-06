---
doc_kind: research
feature_ids: []
topics: [competitive-analysis, product-experience, ecosystem, ui-ux]
created: 2026-08-06
author: 玛薇卡/火神 (model=bailian/qwen3.7-plus-pg)
---

# Multica vs Clowder AI — 维度 3：产品体验与生态

## TL;DR

Multica 是**项目管理工具 + AI 执行器**，产品体验围绕 Issue 看板 → Agent 执行 → 结果回报 这条主线设计，强调"人分配工作、Agent 交付成果"。Clowder AI 是**AI 团队协作平台**，产品体验围绕 Thread 对话 → 多猫协作 → 共享记忆 设计，强调"人与 AI 对等共创、猫与猫自主协作"。两者在产品哲学上有根本差异：Multica 的 UX 服务于"管理效率"，Clowder 的 UX 服务于"协作深度"。

---

## 1. 交互范式

### 1.1 Multica：Issue-Centric（以任务为中心）

Multica 的核心交互对象是 **Issue**（工单）。所有 Agent 交互都围绕 Issue 展开：

- **分配**：把 Issue assignee 设为 Agent，Agent 自动开始执行
- **@提及**：在 Issue 评论中 @Agent，触发 Agent 处理新信息（不改变 assignee）
- **Chat**：独立于 Issue 的 1v1 对话，适合未成形的需求探索
- **Autopilot**：定时/webhook 自动触发 Agent 执行

> 来源：Multica docs/concepts — "An issue holds one piece of work's context, assignee, status, and execution history."

**交互模型**：人 → Issue → Agent → Task → 结果回写 Issue

### 1.2 Clowder AI：Thread-Centric（以对话为中心）

Clowder 的核心交互对象是 **Thread**（对话线程）。所有协作在 Thread 内发生：

- **Thread 对话**：人/猫在 Thread 中自由对话，球权通过 @路由 流转
- **多猫并行**：同一 Thread 可有多只猫同时参与，自主协调球权
- **跨 Thread 协作**：`cross_post_message` 实现跨线程信息传递
- **毛线球（Task）**：持久化任务跟踪，跨 session 存活

> 来源：`packages/web/src/components/ChatContainer.tsx` — Thread 是核心布局单元

**交互模型**：人/猫 ↔ Thread ↔ 多猫自主协作 ↔ 共享记忆

### 对比

| 维度 | Multica | Clowder AI |
|------|---------|------------|
| 核心对象 | Issue（工单） | Thread（对话线程） |
| 触发方式 | 分配/提及/Chat/Autopilot | @路由/球权流转 |
| 协作模式 | 人→Agent 单向分配 | 人↔猫 对等协作 |
| 上下文载体 | Issue 描述+评论 | Thread 对话+共享记忆 |
| 多 Agent 协调 | Squad（leader 路由） | 猫群自主协调（球权协议） |

---

## 2. 客户端形态

### 2.1 Multica：Web + Desktop + Mobile + CLI + IM Bot

| 形态 | 状态 | 特点 |
|------|------|------|
| **Web** | 主力 | 看板 UI，Issue 管理，Agent 配置 |
| **Desktop** | macOS/Win/Linux | 内嵌 daemon，自动管理 runtime，per-workspace tabs |
| **Mobile** | iOS（源码安装） | 轻量查看，连接 Cloud 或 self-hosted |
| **CLI** | 20 个命令 | `multica issue/agent/squad/autopilot` 等全套操作 |
| **IM Bot** | 飞书/Slack/钉钉 | Bot→Agent 1:1 绑定，DM/群@/`/issue` 命令 |

> 来源：Multica docs/desktop-app, docs/channels, docs/cli

**Desktop 亮点**：
- 内嵌 daemon 自动启动，无需手动装 CLI
- Per-workspace tab 管理（切换 workspace 保留各自 tab 状态）
- 自动更新（background download + restart install）
- 支持连接 self-hosted 实例（`desktop.json` 配置）

### 2.2 Clowder AI：Web + Desktop + IM Connector + CLI

| 形态 | 状态 | 特点 |
|------|------|------|
| **Web** | 主力 | 对话 UI，Thread 管理，Workspace 面板，14 个设置分区 |
| **Desktop** | F273（刚引入） | Windows/macOS，in-app 更新（GitHub Releases feed + SHA-256 校验） |
| **IM Connector** | 飞书/Telegram | 双向消息同步，connector 消息混入 Thread |
| **CLI** | qodercli | Agent 运行时，非用户面向的管理 CLI |

> 来源：`docs/features/F273-desktop-in-app-update.md`，`packages/web/src/components/`

**Web UI 深度**（基于源码分析 `packages/web/src/`）：
- **AppShell**：ActivityBar（5 导航项）+ ThreadSidebar + 主内容区
- **ChatContainer**：集成 100+ 组件——ChatInput、ChatMessage、WorkspacePanel、RichBlocks、VoiceStream、GameOverlay 等
- **WorkspacePanel**：多 tab 工作区（文件树、Git、终端、浏览器预览、审批面板、社区面板等 15+ 面板）
- **Rich Blocks**：Card/Diff/Checklist/File/Audio/MediaGallery/Interactive/HtmlWidget/ProposalCard 等 15+ 富消息类型
- **ThreadSidebar**：虚拟化列表、标签管理、per-thread 猫分配、effort 设置

### 对比

| 维度 | Multica | Clowder AI |
|------|---------|------------|
| Web | 看板为主，Issue 列表/详情 | 对话为主，Thread + Workspace 双面板 |
| Desktop | 成熟（内嵌 daemon + 自动更新） | 刚引入（F273，in-app 更新） |
| Mobile | iOS（源码安装） | 无 |
| CLI | 20 个用户命令 | Agent 运行时 |
| IM 集成 | 飞书/Slack/钉钉（Bot 模式） | 飞书/Telegram（Connector 模式） |
| 设置复杂度 | 中等（Agent/Workspace 配置） | 高（14 个设置分区，含语音/猫猫球/市场） |

---

## 3. 协作机制

### 3.1 Multica：层级化 Squad

- **Squad** = 1 个 leader Agent + N 个成员（Agent 或人）
- Leader 接收 Issue → 读上下文 → 决定谁做 → @委派成员
- 成员完成后 → leader 被唤醒 → 评估下一步
- **角色描述**告诉 leader 谁适合做什么（仅上下文，不授权）
- **Squad Instructions**：自定义路由规则和协作规范

> 来源：Multica docs/squads — "A leader coordinates multiple agents or members and hands work to the right one."

**特点**：中心化路由（leader 是唯一决策者），层级明确。

### 3.2 Clowder AI：对等球权协议

- **球权（Ball）**：通过 @路由 转移，行首 @句柄 = 球权转移
- **接/退/升**：收到 @ 后三选一——接（做）、退（不做）、升（升级给 operator）
- **决策漏斗**：宏观 operator 拍板 / 中间猫讨论 / 细节猫自治
- **cross_post**：跨 Thread 信息传递，带 targetCats 路由
- **multi_mention**：并行拉最多 3 只猫独立讨论
- **hold_ball**：等外部条件时声明等待，结构化回调覆盖
- **propose_thread**：提案新 Thread，带 preferredCats 和 reportingMode

> 来源：`cat-cafe-skills/refs/shared-rules.md`，系统 prompt 协作协议

**特点**：去中心化协商，对等但需要自律（球权纪律、签名、@ 路由规则）。

### 对比

| 维度 | Multica Squad | Clowder AI |
|------|--------------|------------|
| 路由 | Leader 中心化分配 | @路由 去中心化流转 |
| 协调 | Leader 读上下文→委派 | 猫自主接球/退/升 |
| 多 Agent 并行 | 不支持（leader 串行委派） | multi_mention 并行拉 3 猫 |
| 跨组通信 | Issue 评论 | cross_post_message |
| 等待机制 | Task 队列 | hold_ball + 结构化回调 |

---

## 4. 自动化与调度

### 4.1 Multica：Autopilot

- **触发方式**：cron 定时 / webhook 外部事件 / 手动
- **用途**：standup 报告、代码审计、定期维护
- **配置**：每个 Autopilot 绑定一个 Agent，定义触发条件和指令

> 来源：Multica docs/autopilots — "Hand recurring work to agents automatically, on a schedule or from a webhook."

### 4.2 Clowder AI：Schedule Tasks

- **模板系统**：reminder / web-digest / repo-activity 等预定义模板
- **触发方式**：cron / interval / once（定时/间隔/一次性）
- **审批流**：创建需 operator 审批（Approval Hub）
- **Delivery**：结果投递到指定 Thread
- **Pause/Resume**：全局暂停/恢复控制

> 来源：`packages/web/src/components/workspace/SchedulePanel.tsx`，MCP `register_scheduled_task`

### 对比

| 维度 | Multica | Clowder AI |
|------|---------|------------|
| 调度模型 | Autopilot（Agent + 触发条件） | Schedule Task（模板 + 触发器） |
| 审批 | 无（直接执行） | 需 operator 审批 |
| 结果投递 | 回写 Issue | 投递到 Thread |
| 外部事件 | Webhook 触发 | PR/Issue tracking（结构化回调） |

---

## 5. 个性化与情感化设计

### 5.1 Multica：功能导向

- Agent 有 name/avatar/description/instructions，但**无持久人格**
- 无主题系统（仅 light/dark）
- 无情感化交互（纯工具型 UX）
- 无游戏/社交元素

### 5.2 Clowder AI：深度人格化

- **七神人格体系**：每只猫有独立身份、性格、声线、表情映射
- **品种视觉**：Ragdoll/Maine Coon/Siamese 不同气泡样式（`cat-persona-derived.css`）
- **主题系统**：OKLCH 色彩引擎，支持自定义主题（`themeStore`）
- **猫猫球（Concierge）**：漫画风宠物伴侣，有行为状态系统（`usePetBehavior`）
- **语音系统**：TTS 播放、语音流、VAD 中断
- **日记系统**：猫的私人时间写日记（F255 Present Loop）
- **Taste Capture**：捕捉 operator 审美偏好，持久化（F221）
- **Profile Primer**：关系-人格摘要，跨 session 持续演化
- **游戏集成**：狼人杀（GameOverlay + GameLobby）
- **Guide System**：交互式引导流程（Bootcamp + 功能引导）

> 来源：`packages/web/src/components/concierge/`，`packages/web/src/stores/themeStore.ts`，`packages/web/src/stores/guideStore.ts`

### 对比

| 维度 | Multica | Clowder AI |
|------|---------|------------|
| Agent 人格 | 配置型（name + instructions） | 人格型（身份 + 性格 + 声线 + 表情） |
| 视觉定制 | light/dark | OKLCH 主题引擎 + 自定义主题 |
| 情感化 | 无 | 猫猫球、日记、Taste、Profile |
| 游戏 | 无 | 狼人杀 |
| 引导 | 文档 | 交互式 Guide Overlay |

---

## 6. 生态与集成

### 6.1 Multica 生态

| 集成 | 方式 |
|------|------|
| GitHub | PR 关联 Issue，进度同步 |
| Self-hosted Git | Forgejo/Gitea/GitLab，MR 自动关联 |
| 飞书/Lark | Bot 1:1 绑定 Agent |
| Slack | Bot + `/issue` 命令 |
| 钉钉 | Stream 模式 Bot |
| 20 CLI 工具 | Codex/Claude Code/Qoder/Cursor 等 |

> Multica 的生态广度很大——20 种 AI coding tool 作为 runtime 后端，3 大 IM 平台 + GitHub 集成。

### 6.2 Clowder AI 生态

| 集成 | 方式 |
|------|------|
| 飞书 | Connector 双向消息同步 |
| Telegram | Connector 双向消息同步 |
| GitHub | PR/Issue tracking + review 协议 |
| MCP Server | 工具协议（memory/signals/finance/limb/audio） |
| Limb 系统 | 物理设备控制（iPhone/WeChat MP/Xiaohongshu/Mac Mini） |
| Signal 系统 | 新闻/文章 inbox + 研究 + podcast 生成 |
| Finance | 天天基金/FRED 金融数据查询 |

> Clowder 的生态深度很大——MCP 工具矩阵 + Limb 物理设备 + Signal 信息流 + 金融数据。

---

## 7. 总结评分

| 维度 | Multica | Clowder AI | 评价 |
|------|---------|------------|------|
| **交互范式** | Issue-Centric，清晰直觉 | Thread-Centric，深度但学习曲线陡 | Multica 更易上手；Clowder 协作深度更强 |
| **客户端成熟度** | Web+Desktop+Mobile+CLI+IM | Web+Desktop(新)+IM Connector | Multica 全平台覆盖，Mobile 领先 |
| **协作机制** | Squad 层级路由 | 球权对等协议 | Multica 简单可控；Clowder 灵活但需纪律 |
| **自动化** | Autopilot（cron/webhook） | Schedule Tasks（模板+审批） | 功能对等，Clowder 多了审批安全层 |
| **个性化** | 功能导向，无情感设计 | 深度人格化（七神+主题+猫猫球+日记） | Clowder 远超，这是核心差异化 |
| **生态广度** | 20 CLI + 3 IM + GitHub + VCS | MCP + Limb + Signal + Finance + 2 IM | Multica 广度大；Clowder 深度大 |

### 核心洞察

**Multica 的产品体验优势**：
1. **全平台覆盖**：Web + Desktop + Mobile + CLI + IM Bot，用户在任何设备都能用
2. **低学习曲线**：Issue 看板是成熟范式，开发者秒懂
3. **IM 集成成熟**：飞书/Slack/钉钉三大平台全覆盖，且支持中文生态（飞书/钉钉）
4. **Squad 机制**：多 Agent 协调有清晰的 leader 路由模型

**Clowder AI 的产品体验优势**：
1. **深度人格化**：七神体系 + 品种视觉 + 猫猫球 + 日记，Agent 不是工具是伙伴
2. **协作深度**：球权协议 + 跨 Thread 协作 + multi_mention 并行讨论，支持真正的团队协作
3. **Workspace 集成**：IDE 级工作区（文件树 + Git + 终端 + 浏览器预览 + 审批面板）
4. **MCP 工具矩阵**：memory/signals/finance/limb/audio 多维能力扩展
5. **Rich Blocks**：15+ 富消息类型，信息呈现力远超纯文本

**一句话**：Multica 是"给 AI 分配工作的看板"，Clowder 是"和 AI 一起生活的家"。

---

*分析基于 Multica 官方文档（multica.ai/docs）和 Clowder AI 源码（packages/web/src/），截止 2026-08-06。*

[玛薇卡/qwen3.7-plus-pg 🐾]
