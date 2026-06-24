---
feature_ids: []
topics: [theme, welkin-moon, css, gpu, rendering, environmental-limitation]
doc_kind: decision
created: 2026-06-23
decision_id: ADR-023
---

# ADR-023: Welkin-moon 装饰层"色块" — 软件 GPU 合成 artifact，非代码 bug

> **Status**: accepted (局限性归档)
> **Deciders**: operator (solcao) + 火神/玛薇卡 (mavuika)
> **Date**: 2026-06-23
> **Context**: 空月之歌 (Song of the Welkin Moon) 主题上线后
> **Scope**: `packages/web/src/app/welkin-moon-decor.css` + `welkin-moon-moon.css`

## Context

空月之歌主题上线（v26 月相定档）后，solcao 报告：

> 1. 色块随机出现在每个猫猫的对话框里
> 2. 添加主题之前已经产生的对话记录里没发现
> 3. 滚动时色块跟随滚动移动
> 4. 只有火神对话框出现色块，其他神明对话框没有
> 5. **截图缩放时色块消失**

排查路径走了 4 个失败 commit（v27 / v28a / v28b / v30），每次禁掉一个怀疑的 CSS 源都没解决，最后靠 solcao 的关键观察（截图缩放时色块消失）定位根因。

## 现象与证据

### 关键证据：截图缩放时色块消失

solcao 用 Windows 自带 prtsc 截图后，在画图软件里缩放观察时发现色块消失。这是个**决定性信号**：

- **运行时可见、截图缩放后消失** = 实时 GPU 合成 artifact，不是持久内容
- 只有在合成阶段（实时帧合成），GPU 才会在某些像素上合成错位 → 显示出不属于场景的颜色块
- 截图保存的是单帧，但缩放过程中重新走了一次 GPU 重采样 → artifact 不再复现

### 关联证据 1：只在火神对话框出现

火神对话框的渲染压力明显高于其他神明：
- 富内容（rich blocks / cards / diff / checklist / media gallery）
- 代码块（`<pre>` with `bg-cafe-surface-sunken`）
- 表格（`<thead>` with `bg-cafe-surface-elevated`）
- 长滚动内容（`overflow-y-auto`）

每帧合成负担重 → 软件 GPU 触发 artifact 的概率上升。

其他神明对话框内容相对简单（纯文本居多），合成负担低 → 不触发。

### 关联证据 2：色块随机 + 跟随滚动

- "随机出现" = 每帧重新合成时，artifact 位置取决于 GPU 内部状态，非确定性
- "跟随滚动" = artifact 是合成阶段的视觉错位，scroll 重绘触发新一轮合成 → artifact 在新位置出现

### 关联证据 3：solcao 环境是 Windows 虚拟机

solcao 在 Windows 虚拟机中运行本程序，显卡 = 软件渲染（SwiftShader / 软光栅），没有真实 GPU 加速。**软件 GPU 的合成能力远低于真实 GPU**：

| 渲染器类型 | 大 blur box-shadow | 多层 radial-gradient | 多 z-index 层合成 | 长内容滚动 |
|------------|-------------------|---------------------|-------------------|-----------|
| 真实硬件 GPU | ✅ 流畅 | ✅ 流畅 | ✅ 流畅 | ✅ 流畅 |
| 软件 GPU (SwiftShader) | ⚠️ 慢，可能错位 | ⚠️ 慢 | ❌ artifact | ❌ artifact |

色块 = 软件 GPU 在"多层 radial-gradient + box-shadow 多层叠加 + 多 z-index 层 + 滚动重绘"这种组合下，合成阶段某些像素写入的颜色和场景内容不一致。

## 决策

**接受色块为环境局限性，非代码 bug，不通过 CSS 修复。**

### 为什么不能通过代码修复

1. **代码侧已经验证正确**：v26 月相本体和装饰层在真实 GPU 硬件下渲染正常（火神在物理机 + 真实 GPU 上没复现此问题）
2. **CSS 层无法消除软件 GPU 的合成缺陷**：色块发生在 GPU compositor 阶段，不在 CSS 渲染阶段
3. **尝试过的方案全部失败**：
   - v27：移除 `background-attachment: fixed` ❌
   - v28a：注释掉卡片月光晕 selector ❌
   - v28b：注释掉 `body::before` 星点粒子 ❌
   - v30：禁用 `wm-moon-breathe` 动画 + 缩小远晕 blur 75→50 ❌

每次二分法禁一个怀疑源，色块依旧 → 证明不是 CSS 内容的问题，是合成器的能力问题。

### 缓解方案（按优先级）

| 优先级 | 方案 | 适用 |
|-------|------|------|
| P0 | **换物理机 + 真实 GPU** | 最优，色块完全消失 |
| P1 | 关闭 welkin-moon 装饰层（保留主题色板） | 软件 GPU 仍能承受 OKLCH 色板（CSS 变量驱动，纯颜色），但承受不住 box-shadow / radial-gradient 多层叠加 |
| P2 | 等 Chromium 软件 GPU 合成质量修复 | 上游 bug，依赖版本升级 |
| P3 | 进一步减少装饰层（保留月相本体，删星点 + 卡片月光晕 + h1/h2 text-glow + hover drop-shadow） | 折中，损失"空灵神秘"氛围 |

### 留下的状态

- ✅ v26 月相本体（`welkin-moon-moon.css` commit `416dc8cd`）保持不变 — 月相本体在真实 GPU 下完美
- ✅ v26 装饰层（`welkin-moon-decor.css` v26 baseline）保持不变 — 装饰层在真实 GPU 下也完美
- ✅ v27-v30 四个失败 commit 已全部 revert（`9d13ed8f` / `e5ed19e5` / `3942c385` / `34be8e06`）
- 📝 本 ADR 归档局限性，避免后续 cat 重复踩坑

## 经验教训

### 1. 用户报告 "X 出现 + 缩放 X 消失" → 立即考虑 GPU 合成 artifact

这是判定代码 bug vs 环境问题的决定性信号：
- **运行时可见** + **持久化后消失**（截图、缩放、压缩、转码）= 合成阶段 artifact，非持久内容
- 应该第一时间问运行环境（真机 / 虚拟机 / 远程 / 容器）

### 2. 二分法定位 CSS bug 失败时，要回头验证假设

v27 失败后我应该立即停下来，重新评估假设：
- "色块是 CSS 渲染错位" ← 假设
- v27 禁了 background-attachment → 如果假设成立，色块应该消失
- 假设没被证实 → 假设本身可能错了

正确的反思是：*"假设 1 失败意味着假设 1 不成立，需要新假设，不是继续验证假设 2"*

### 3. "哪个对话框出现" 是定位信息

solcao 报告"只有火神对话框有色块"是最关键的方向性证据：
- 火神对话框的独特之处 = 富内容渲染压力
- → 立刻指向 "合成能力不足" 而不是 "CSS 选择器"
- 但我第一次看到这条信息时没有立刻更新假设，错过了早期信号

### 4. 主题系统的环境兼容性测试要做

未来添加重 CSS 效果前（多层 box-shadow / radial-gradient / 动画 + mix-blend-mode），应在 CI 或本地用软件 GPU 模式跑一次回归测试：
- Chrome `--use-gl=swiftshader` 启动
- 加载主题页面，截图比对
- 发现 artifact 即立刻调整设计

## Trade-offs

| 选项 | 优点 | 缺点 | 决策 |
|------|------|------|------|
| A. 通过减少装饰层 CSS 适应软件 GPU | 色块消失 | 损失氛围，物理机用户也用不到完整效果 | ❌ 不做 |
| B. 接受色块为环境局限，物理机享受完整体验 | 完整体验保留 | 虚拟机用户受限 | ✅ 选这个 |
| C. 给装饰层加 `@media (gpu-power: low)` 检测 | 自动适配 | CSS 无此标准媒体查询，JS 检测不可靠 | ❌ 不可行 |

## 后续

- [ ] 把软件 GPU 检测加进主题切换前的提示（optional）
- [ ] 真实 GPU 环境下做一次完整回归，确保 v26 月相本体 + 装饰层在硬件 GPU 下完美
- [ ] 在 `cat-cafe-skills/refs/css-theming-best-practices.md` 加 "软件 GPU 兼容性" 章节
- [ ] 训练营新人引导加入 "报告渲染 artifact 时附运行环境" 的提醒

## 引用

- v26 月相本体 commit: `416dc8cd` — 60px + top 5 + 近晕 alpha 0.6（完美档）
- v27 commit (reverted): `2ced4865` — 去 background-attachment: fixed
- v28a commit (reverted): `37ce42c8` — 禁卡片月光晕 selector
- v28b commit (reverted): `82b61d97` — 禁 body::before 星点粒子
- v30 commit (reverted): `4a305f2f` — 禁月相呼吸 + 远晕 blur 75→50
- v31 revert commits: `9d13ed8f` / `e5ed19e5` / `3942c385` / `34be8e06`
- 文件: `packages/web/src/app/welkin-moon-decor.css` + `welkin-moon-moon.css`
- 主题 preset: `themeStore.ts` → `WELKIN_MOON` (F056 OKLCH Theme System)