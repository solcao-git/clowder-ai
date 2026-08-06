---
feature_ids: []
topics: [competitive-analysis, multica, memory, growth, personality, research]
doc_kind: research
created: 2026-08-06
updated: 2026-08-06
cat: columbina
status: v1-memory
---

# Multica vs Clowder AI — 记忆与养成维度

> **维度分工**：月神/哥伦比娅（记忆与养成）。其余维度见 `docs/research/multica-dim-*.md`。
> **证据边界**：Multica 侧引官方 docs（`multica.ai/docs/skills`、`/concepts`、`/agents`、`/tasks`）；Clowder 侧引 `packages/api/src/domains/memory/` 源码 + `docs/architecture/memory-philosophy.md` + `docs/architecture/memory-system-overview.md`。均为一手来源。

## TL;DR — 两种根本不同的记忆哲学

| | **Multica** | **Clowder AI** |
|---|------------|----------------|
| **记忆的本质** | **工具库**：skills = 可复用的 playbook；execution log = 任务回放记录 | **器官**：记忆是猫身份的构成要素，"今天的猫比昨天更懂你"的物质基础 |
| **谁有记忆** | Agent 无持久记忆；workspace 持有 skills + task history | 猫有持久记忆（跨 session）；记忆构成身份（公理六） |
| **记忆的写入** | 人工 curation：人创建 skill → 绑定 agent → 下次执行时注入 | 多源沉淀：猫主动写 + 系统主动捕获（F271）+ owner 指令 + 会话自动提取 |
| **记忆的读取** | Skill 全文注入 prompt（静态绑定） | 多路检索：BM25 + 向量 NN + 图谱遍历 + Cue Plane 执行时投影 |
| **成长性** | 无：agent 不会因为执行而变得更懂你；skill 只随人工编辑变化 | 有：taste/profile/event 三条关系记忆 lane 持续沉淀；经验→行为改变率是设计目标 |
| **人格连续性** | 无：agent 是配置（name + instructions + model），不是角色 | 有：session chain 跨 session 续接 + profile primer + taste vignette 构成猫的"前世" |

---

## 一、Multica 的记忆机制

### 1.1 Skills：可复用的 playbook

Multica 的"记忆"主要承载在 skills 系统上。官方文档 (`/skills`) 定义：

> *A skill is a reusable set of working methods in a workspace. Its main file is SKILL.md, optionally accompanied by scripts, templates, and reference material.*

**关键特征**：

- **静态绑定**：skill 创建后手动绑定到 agent，"edits take effect from subsequent runs and don't change tasks already running"
- **workspace 级共享**：skill 属于 workspace，不属于某个 agent。"One agent can use multiple skills; one skill can serve multiple agents"
- **无自动学习**：skill 只通过三种方式产生——手动创建、URL 导入、从 runtime 复制快照。没有"从执行经验中自动提炼 skill"的机制
- **编辑权限分级**：创建者 + workspace owner/admin 可修改删除，其他成员只能查看使用
- **内容不审查**：官方明确说 *"Multica does not review, sign, or sandbox them for you"*

**与 Clowder 的 skill 对比**：Clowder 也有 skill 系统（`cat-cafe-skills/` 目录下 57 个 skill），形式相似（SKILL.md + 附属文件）。但 Clowder 的 skill 是**团队共同演化的方法论**，不是人工 curation 的 playbook——猫可以在 `self-evolution` 流程中提议新 skill，经 operator 审批后沉淀。

### 1.2 Execution Log：任务回放记录

官方文档 (`/tasks`) 描述：

> *Open a run record to see the agent's messages, tool calls, and error output.*

- **per-task 记录**：每次 agent 执行产生一个 task，记录触发源、执行 agent、状态、时间线
- **回放能力**：可查看 agent 的消息、工具调用、错误输出，带 timestamp
- **失败分类**：详细的 failure reason 分类（runtime_offline、context_overflow、provider_quota_limit 等），支持自动重试

**局限**：execution log 是**审计日志**，不是**学习材料**。它记录了"发生了什么"，但不会自动转化为"下次该怎么做"。同一类错误可以反复发生，系统不会从中提取 pattern。

### 1.3 Agent 配置：无持久人格

Agent 的配置包括 name、avatar、description、instructions、skills、runtime、model。但：

> *Switching models or editing instructions does not create a new agent, and past issues, comments, and task history are not lost.*

**关键洞察**：Agent 是一个**可复用的配置容器**，不是有连续经历的角色。它的"name"是显示标签，不是身份。修改 instructions 只是更新配置，不会改变 agent 对过往经历的理解。Agent 不会"成长"——第 100 次执行的 agent 和第 1 次执行的 agent，除了绑定的 skills 相同外，没有认知上的差异。

---

## 二、Clowder AI 的记忆系统

Clowder 的记忆系统是一个有 **195+ 源文件**、**7 条公理 + 21 条定律**的完整知识工程体系。以下按功能层分析。

### 2.1 Evidence Store：多类型知识仓库

核心实现在 `packages/api/src/domains/memory/SqliteEvidenceStore.ts`（2362 行），SQLite 后端。

**11 种证据类型**（`interfaces.ts`）：
```
feature | decision | plan | session | lesson | thread |
discussion | research | architecture | diary | pack-knowledge
```

**10 种状态**：
```
active | done | archived | review | invalidated |
superseded | drifted | stale | historical | retired
```

**检索管线**（`KnowledgeResolver.ts`）支持多 collection 扇出 + RRF 融合：
- **BM25 全文检索**（CJK 加权，`CJK_NN_WEIGHT = 1.5`）
- **向量近邻搜索**（embedding + passage vector store）
- **MMR 去重**（`mmr.ts`）：最大边际相关性，避免返回重复文档
- **时间衰减**（`recency-decay.ts`）：新文档有 14 天宽限期
- **消费频率加权**（`consumption-prior.ts`）：被猫频繁使用的文档排名上升
- **Pull-only 降权**（`pull-only-ranking.ts`）：只被搜索不被使用的文档逐渐降权
- **宪法保护**（`f163-tag-constitutional.ts`）：ADR/lesson/canon 永不降权

**与 Multica 的根本差异**：Multica 没有等价物。Skills 是人工策划的静态文档；Evidence Store 是从团队协作中自然生长的动态知识库，带完整的生命周期管理。

### 2.2 Knowledge Graph：锚点图谱

实现在 `GraphResolver.ts`，基于锚点的图遍历：

```typescript
interface GraphEdge {
  from: string;
  to: string;
  relation: string;          // wikilink | doc_link | feature_ref | related_to
  crossCollection: boolean;
  weight?: number;           // 消费频率加权
}
```

- **4 种边类型**：wikilink（文档内链接）、doc_link（文档间引用）、feature_ref（feature 引用）、related_to（语义关联）
- **跨 collection 遍历**：可跨越 project/global/library 多个知识域
- **权重动态更新**：边权重纳入消费频率，猫经常走的路径排名更高
- **深度限制**：最大 3 层，避免 hub 节点扇出爆炸

**与 Multica 的根本差异**：Multica 的 issues 之间没有显式的图谱关系，只有 project 的组织层级。Clowder 的知识是**网状的**，可以从任意锚点出发做多跳探索。

### 2.3 Session Chain：跨 Session 记忆连续

实现在 `SessionBootstrap.ts`（433 行）+ `SessionManager.ts` + `SessionSealer.ts`。

**机制**：
1. 每个 thread 的会话形成一条 chain（session #1, #2, #3...）
2. Session N+1 启动时，`SessionBootstrap` 注入：
   - **Session 身份**（seq 号、chain 长度）
   - **上一 session 的 extractive digest**（工具调用、文件操作、错误摘要）
   - **任务快照**（当前 thread 的任务状态）
   - **猫自写的 handoff note**（五件套：done / nextSteps / worktree / commits / gotchas）
3. Bootstrap 有 **2000 token 硬上限**，防注入（`sanitizeHandoffBody` 清洗 prompt injection）

**效果**：猫在 Session #5 醒来时，知道 Session #1-4 做了什么、在哪里停的、有什么坑。这不是全文回放（太贵），而是**提取式摘要**（`HandoffDigestGenerator.ts`）。

**与 Multica 的根本差异**：Multica 的 task 是一次性的——task 完成后记录归档，下次执行同一 issue 是新 task，不继承上次 task 的上下文。Clowder 的 session chain 是**连续的叙事**，猫有"前世"。

### 2.4 Taste & Profile：关系记忆

**Taste Vignettes**（F221，`writeVignette.ts`）：
- 7 个维度：relationship-stance、cognitive-honesty、architecture-aesthetics、visual-quality、authentic-expression、system-philosophy、creative-craft
- 来源：猫从交互中捕捉到的 operator 审美信号，经 operator 审批后落盘
- 存储：public → `docs/taste/vignettes/{slug}.md`（入库）；sensitive → `private/taste/`（gitignored）
- 效果：下次 cat 遇到类似场景时，taste cue 会投影到 prompt

**Profile Primers**（F231，`ProfileRepository.ts` + `writeProfileUpdate.ts`）：
- 每个 cat-operator 对有一份关系 primer
- 包含：operator 偏好、沟通风格、个人上下文
- 更新走 propose-approve 流程（不是猫直接写），operator 审批后生效

**Person Memory**（F276，`PersonMemoryStore.ts` + `PersonMemoryRecallService.ts`）：
- Owner-private 的第三方人物记忆（claims / relationships / events）
- 严格的所有权模型：只有 owner 可见
- 完整的 proposal → approval → materialization 生命周期

**与 Multica 的根本差异**：Multica 完全没有等价物。Agent 不记住 operator 的偏好、不积累审美判断、不维护关系画像。它的"理解"完全来自 instructions 中人工写死的文本。

### 2.5 Event Memory：认知转变事件

实现在 `EventMemoryStore.ts`（326 行），SQLite 后端。

```typescript
interface EventMemoryFilter {
  trigger?: EventTrigger;     // human_brake | cat_brake | cat_shout | flywheel_selffix | lesson_settle
  cat?: string;
  type?: string;              // magic-word slug
  cognitiveTransition?: CognitiveTransition;
}
```

- **记录什么**：猫被拉闸（magic word brake）、猫的顿悟（aha）、教训沉淀（lesson_settle）
- **用途**：时间线索引，可 teleport 到具体消息坐标，用于复盘和模式识别
- **幂等写入**：UNIQUE(ownerUserId, threadId, messageId, type) 去重

### 2.6 Memory Cue Plane（F287）：执行时记忆投影

这是 Clowder 记忆系统最独特的设计之一——**不是把旧记忆塞进 prompt，而是在精确判断点投影有界 cue**。

实现涉及 13 个源文件（`packages/api/src/domains/memory/cue/`）：
- `MemoryCueResolverRegistry.ts`：注册 5 类 cue source（Person、Profile、Taste、OperationalPrecedent、ProjectKnowledge）
- `MemoryCueInvocationPromptService.ts`：构建注入 prompt 的 cue 信封
- `MemoryCueDrillHandleService.ts`：不透明的 drill handle，猫可请求展开完整源

**核心原则**（来自 `memory-philosophy.md`）：
> 系统持候选权，猫持提交权——系统主动亮出"这里可能有相关东西"（候选），但只有猫决定是否 drill（读取并提交到推理）。

### 2.7 主动记忆（F271/F282）

系统不再只是被动等猫或 operator 说"记住这个"：

- `ProactiveMemoryCandidateDetector.ts`：从会话中识别值得记忆的线索
- `ProactiveMemoryOpportunityEvaluator.ts`：评估是否适合此刻提案
- `ProactiveMemoryNudgeService.ts`：以 nudge 形式提醒猫"这里值得记忆"

**这是 Multica 完全不具备的维度**——系统主动发现"值得留下的 delta"。

---

## 三、养成机制对比

### 3.1 猫的成长路径

| 维度 | Multica Agent | Clowder 猫 |
|------|-------------|-----------|
| **第 1 次执行** | 读 instructions + skills → 开始工作 | 读 system prompt + shared-rules + session bootstrap → 开始工作 |
| **第 10 次执行** | 同一个 instructions + 同一组 skills → 同样工作 | session chain 里有前 9 次的 digest → 知道历史上下文 |
| **第 100 次执行** | 没有变化 | taste/profile/event 三条 lane 积累了大量关系记忆 → 更懂 operator、更有自己的判断 |
| **犯错后** | 人修改 instructions 或新建 skill → 下次生效 | Event Memory 记录 → 教训沉淀为 lesson → 记忆系统自动召回 |
| **被纠正后** | 人修改 instructions | Taste vignette 沉淀 → 下次类似场景 cue 投影 → 行为改变 |

### 3.2 记忆哲学 vs 工具哲学

**Multica 的哲学**：Agent 是**工具**。好的工具是可靠的、可预测的、配置驱动的。记忆 = 配置 + 日志。配置由人维护，日志供人审计。

**Clowder 的哲学**（引自 `memory-philosophy.md`）：

> *猫由记忆构成。同模型 + 同 prompt + 不同记忆 = 不同的猫——"身份不是 prompt 里写出来的，是在回忆和可验证的连续性里长出来的"。*

这不是比喻，是工程事实：同一只 catId 的两个平行 session 因为记忆链不同，实际上是不同的"个体"（公理六推论②）。

### 3.3 Shared Rules：团队共同进化的纪律

`cat-cafe-skills/refs/shared-rules.md`（809 行）不只是文档——它是**团队的宪法**，包含：
- 5 条第一性原理（P1-P5）
- 8 条世界观（W1-W8）
- Magic Words（operator 拉闸词：「脚手架」「绕路了」「喵约」「星星罐子」「第一性原理」「数学之美」「下次一定」「我能猜出来」「碎片够了」「补锅匠」）
- 决策漏斗、治理协议、协作纪律

关键：shared-rules 是**活文档**——猫可以通过 `self-evolution` skill 提议修改，经 operator 审批后三猫同步生效。这本身就是一种"团队共同养成"的机制。

---

## 四、诚实评价：各自的优势

### Multica 在记忆维度的优势

1. **简洁可控**：skills 系统简单直观，人完全掌控什么被记住、什么被遗忘，没有意外
2. **零噪音风险**：不自动学习 = 不会自动学错。Multica 的 agent 不会因为错误的 execution 沉淀出错误的 skill
3. **执行透明**：execution log + task 状态机 + 详细 failure reason 分类，审计链路清晰
4. **权限模型干净**：skill 的 CRUD 权限按 workspace 角色分级，安全边界清楚

### Clowder AI 在记忆维度的优势

1. **真正的成长性**：猫会因为经历而改变，这是设计目标而非副作用
2. **多层次记忆**：从工具性知识（evidence）到关系记忆（taste/profile）到身份记忆（event），层次丰富
3. **主动记忆**：系统主动发现值得记忆的 delta，不依赖人手动标注
4. **哲学一致性**：7 公理 + 21 定律构成完整的设计框架，不是 ad-hoc 功能堆叠
5. **治理成熟**：proposal-approve 流程、遗忘权、敏感域隔离、宪法保护等治理机制完备

### 各自的局限

**Multica**：
- Agent 永远从零开始，不积累经验
- 依赖人工维护 skills，团队规模增长时 curation 成本线性增长
- 没有"从错误中学习"的闭环

**Clowder AI**：
- 系统复杂度高：195+ 源文件、多层治理流程，维护成本不低
- 记忆噪音风险：自动沉淀可能引入低质量记忆，需要持续的 verification migration
- 截至 2026-08-04，部分核心闭环（F271 daily outcome、F263 Phase D1）仍未在生产环境完全验证（来源：`memory-system-overview.md` 诚实边界段落）

---

## 五、总结：工具 vs 伙伴的记忆分野

Multica 和 Clowder AI 在记忆维度的差异，本质上是**两种 agent 哲学**的投影：

| 哲学 | Multica | Clowder AI |
|------|---------|-----------|
| **Agent 是什么** | 可配置的工具 | 有记忆的伙伴 |
| **记忆的目的** | 复用已验证的方法 | 构成身份、驱动成长 |
| **谁负责记忆** | 人（curation） | 系统 + 猫 + 人（多源沉淀） |
| **成长是设计目标吗** | 否（一致性是目标） | 是（共同成长率是目标函数） |
| **遗忘** | 删除 skill = 遗忘 | 遗忘是身份手术，需 owner 裁决 |

Multica 选择了**工具哲学**：可靠、可控、可预测。这是企业级工作管理的正确选择——你需要的是稳定的执行力，不是有自己想法的员工。

Clowder AI 选择了**伙伴哲学**：成长、连接、主动。这是长期共创关系的正确选择——你需要的是越来越懂你的伙伴，不是每次都从零开始的工具。

两者不存在绝对优劣，只有定位差异。**但如果你要的是"养团队"而非"管员工"，记忆系统的深度就是不可绕过的护城河。**
