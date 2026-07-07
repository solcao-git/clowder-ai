# CodeBuddy CLI 接入 Clowder AI 指南

本文档供猫咖（Clowder）接入工程师使用，描述如何将腾讯 CodeBuddy CLI 作为一只猫接入 Clowder AI 平台。

## 背景信息

### CodeBuddy CLI 概况

| 项 | 值 |
|----|-----|
| npm 包 | `@tencent-ai/codebuddy-code` |
| 版本 | 2.117.1（截至 2026-07-07） |
| 命令 | `codebuddy`（别名 `cbc`） |
| 协议支持 | **ACP（Agent Client Protocol）** stdio 模式 ✅ |
| ACP 启动 | `codebuddy --acp --acp-transport stdio` |
| 自定义模型 | ✅ 通过 `~/.codebuddy/models.json` 支持 OpenAI 兼容端点 |
| 内置模型 | glm-5.2 / glm-5.1 / minimax-m3 / kimi-k2.7 / deepseek-v4-pro 等（走腾讯云后端，需套餐） |

### 关键发现

1. **CodeBuddy 支持 ACP 协议**（`--acp` 标志），这意味着可以走 Clowder 的通用 ACP 路径（`clientId: 'acp'`）接入，**无需写新的 AgentService adapter**。
2. **CodeBuddy 支持自定义模型**（`~/.codebuddy/models.json`），可配置任意 OpenAI 兼容端点 + API key，不依赖腾讯套餐。
3. CodeBuddy 的内置模型走腾讯云后端（需套餐/免费额度），自定义模型走用户自己的 provider key。

---

## 接入方案

### 推荐路径：ACP 协议接入（零代码改动）

CodeBuddy 的 `--acp` 模式说标准 ACP JSON-RPC over stdio，和 Trae CLI 的 `trae-cli acp serve` 类似。Clowder 的 F161 通用 ACP 路径（`clientId: 'acp'`）纯配置驱动，**不需要写代码**。

#### 步骤 1：确认 CodeBuddy 已安装且 ACP 可用

```powershell
# 确认命令在 PATH
codebuddy --version

# 确认 ACP 模式
codebuddy --acp --help
# 应显示: --acp  Start in ACP (Agent Client Protocol) mode
```

#### 步骤 2：配置自定义模型（可选，但推荐）

如果不配自定义模型，CodeBuddy 走腾讯云后端（受套餐额度限制）。配了自定义模型后，走用户自己的 provider key。

创建 `~/.codebuddy/models.json`：

```json
{
  "models": [
    {
      "id": "qwen3.7-max",
      "name": "Qwen3.7-Max (百炼)",
      "vendor": "Alibaba",
      "apiKey": "<百炼 API key>",
      "maxInputTokens": 128000,
      "maxOutputTokens": 8192,
      "url": "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
      "supportsToolCall": true,
      "supportsImages": false
    }
  ]
}
```

**字段说明：**

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | ✓ | 模型唯一标识符，`--model` 参数用这个 |
| `name` | - | 显示名称 |
| `vendor` | - | 供应商名 |
| `apiKey` | - | API 密钥（实际值，非环境变量名） |
| `url` | - | **完整端点路径**，必须以 `/chat/completions` 结尾 |
| `maxInputTokens` | - | 最大输入 token |
| `maxOutputTokens` | - | 最大输出 token |
| `supportsToolCall` | - | 是否支持工具调用（建议 true） |
| `supportsImages` | - | 是否支持图片输入 |
| `supportsReasoning` | - | 是否支持推理模式 |

**注意事项：**
- `url` 必须是完整路径（如 `.../v1/chat/completions`），不能只写到 `/v1`
- 不设 `availableModels` 字段则显示所有模型
- 配置文件支持热重载（1 秒防抖延迟）
- 自定义模型在 TUI `/model` 菜单中带 `custom-local` 标签

#### 步骤 3：在 Clowder catalog 加 breed

在 `.cat-cafe/cat-catalog.json` 的 `breeds` 数组里加一个新 breed。参考 Trae/Qoder 的接入方式：

```json
{
  "id": "codebuddy-acp",
  "catId": "<选一个原神角色名，如 columbina>",
  "name": "<猫名>",
  "displayName": "<猫名>",
  "nickname": "<昵称>",
  "avatar": "/avatars/<avatar>.png",
  "color": {
    "primary": "#<颜色>",
    "secondary": "#<颜色>"
  },
  "mentionPatterns": ["@<mention1>", "@<mention2>"],
  "roleDescription": "<角色描述>",
  "defaultVariantId": "codebuddy-acp-default",
  "features": {
    "sessionChain": false
  },
  "variants": [
    {
      "id": "codebuddy-acp-default",
      "clientId": "acp",
      "defaultModel": "qwen3.7-max",
      "mcpSupport": true,
      "cli": {
        "command": "codebuddy",
        "outputFormat": "stream-json"
      },
      "acp": {
        "command": "codebuddy",
        "startupArgs": ["--acp", "--acp-transport", "stdio", "-y"],
        "mcpWhitelist": ["cat-cafe", "cat-cafe-memory", "cat-cafe-collab", "cat-cafe-signals"],
        "supportsMultiplexing": false
      },
      "accountRef": "<绑一个已有账号，如 my-bailian>",
      "personality": "<性格描述>",
      "roleDescription": "<角色描述>"
    }
  ]
}
```

**关键字段说明：**

| 字段 | 值 | 说明 |
|------|-----|------|
| `clientId` | `"acp"` | 走通用 ACP 路径（F161），零代码改动 |
| `acp.command` | `"codebuddy"` | CodeBuddy 命令名（必须在 PATH） |
| `acp.startupArgs` | `["--acp", "--acp-transport", "stdio", "-y"]` | ACP 模式启动参数，`-y` 跳过权限询问 |
| `acp.mcpWhitelist` | 4 个核心 cat-cafe MCP | 避免加载 90+ 工具导致卡顿 |
| `acp.supportsMultiplexing` | `false` | 保守起见，每会话独立进程 |
| `defaultModel` | `"qwen3.7-max"` | 对应 models.json 里的模型 id |
| `accountRef` | 已有账号 | ACP 路径对账号校验返回 null（任意账号都接受），但路由层要求 accountRef 必填 |

#### 步骤 4：在 roster 加 entry

在 catalog 的 `roster` 对象里加对应 catId 的 entry：

```json
"<catId>": {
  "family": "<家族名>",
  "roles": ["<角色>"],
  "lead": false,
  "available": true,
  "evaluation": "<评价>"
}
```

#### 步骤 5：同步 cat-template.json

在 `cat-template.json` 里加同样的 breed（保持 template 和 catalog 同步，避免合并冲突）。**catId 必须一致。**

#### 步骤 6：重启平台验证

```powershell
.\scripts\start-windows.ps1
```

新建 thread → `@<猫名>` → 发测试消息。

---

## 接入时必须同步的枚举点（如果走 clientId='acp' 则无需改）

**重要：如果用 `clientId: 'acp'`（推荐），不需要改任何枚举。** ACP 是通用路径，已内置支持。

只有当你要把 CodeBuddy 加成独立 clientId（如 `'codebuddy'`）时，才需要改以下所有地方（不推荐）：

| 文件 | 改动 |
|------|------|
| `packages/shared/src/types/cat.ts` | `ClientId` 联合类型加 `'codebuddy'` |
| `packages/shared/src/types/client-routing.ts` | `BuiltinAccountClient` + `BUILTIN_ACCOUNT_IDS` + `builtinAccountFamilyForClient` |
| `packages/api/src/routes/cats.ts` | `clientSchema` enum 加 `'codebuddy'` |
| `packages/api/src/routes/accounts.ts` | `BUILTIN_CLIENT_FOR_ID` 加 `codebuddy` |
| `packages/api/src/config/account-resolver.ts` | `BUILTIN_ACCOUNT_MAP` 加 `codebuddy` |
| `packages/web/src/components/hub-cat-editor.model.ts` | `ClientId` + `CLIENT_OPTIONS` 加 `'codebuddy'` |
| `packages/web/src/components/hub-accounts.types.ts` | `BuiltinAccountClient` 加 `'codebuddy'` |
| `packages/web/src/components/hub-quota-pools.ts` | `BUILTIN_CLIENT_LABELS` 加 `codebuddy` |
| `packages/web/src/components/UnifiedAuthModal.tsx` | `CLIENT_OPTIONS` 加 `'codebuddy'` |
| `packages/web/src/lib/color-defaults.ts` | `CAT_COLORS` 加对应颜色 |

---

## 已知风险与注意事项

### 1. ACP 握手兼容性

CodeBuddy 的 ACP 实现需要实测验证。Clowder 的 `AcpClient` 握手流程：
1. 发 `initialize`（`protocolVersion: 1`）→ 等响应
2. 发 `session/new`（`cwd` + `mcpServers`）→ 等响应
3. 发 `session/prompt` → 流式接收 `session/update`

**如果 CodeBuddy 的 ACP 响应格式和 Clowder 期望的不一致**，可能出现：
- 握手失败（猫连不上）
- 回复内容异常（事件解析问题）

排查方法：看 API 日志里 `ACP session/new: response received` 是否出现，看 `~/.codebuddy/logs/` 下的日志。

### 2. CLI 路径问题

如果 `codebuddy` 不在系统 PATH，`acp.command` 要用绝对路径：
```json
"command": "C:\\Users\\Administrator\\AppData\\Roaming\\npm\\codebuddy.cmd"
```
注意 Windows 路径反斜杠要转义（`\\`）。换机器要更新路径。

### 3. 模型权限验证

配自定义模型后，**必须用 curl 直接打端点验证 key 有权限**，不能只看 CodeBuddy 表面回复（CodeBuddy 可能在自定义端点 403 时 fallback 到腾讯内置后端，造成"通了"的假象）：

```powershell
curl -s -X POST `
  -H "Authorization: Bearer <key>" `
  -H "Content-Type: application/json" `
  -d '{"model":"<model-id>","messages":[{"role":"user","content":"hi"}],"max_tokens":20}' `
  "<url>"
```

返回 `Model access denied` = key 没权限；返回正常 JSON = 有权限。

### 4. MCP 加载

CodeBuddy 的 ACP 模式下，MCP servers 通过 `session/new` 的 `mcpServers` 参数传递。`mcpWhitelist` 控制哪些 cat-cafe 内置 MCP server 会传给 CodeBuddy。建议先用 4 个核心 server，避免 90+ 工具 schema 导致初始化卡顿。

### 5. CodeBuddy 不支持 `notifications/initialized`

和 Trae 类似，CodeBuddy 的 ACP 实现可能不支持 LSP 标准的 `notifications/initialized` 通知。Clowder 的 `AcpClient` 不发送这个通知，所以应该没冲突。但如果握手出问题，检查这里。

---

## 验证清单

接入完成后逐项验证：

- [ ] `codebuddy --version` 正常
- [ ] `codebuddy --acp --help` 显示 ACP 选项
- [ ] `~/.codebuddy/models.json` 配置正确（JSON 格式、url 完整路径）
- [ ] curl 直接打 provider 端点验证 key 有权限
- [ ] `codebuddy -p "hi" --model <model-id>` 自定义模型能回复
- [ ] catalog breed 配置正确（`clientId: 'acp'` + `acp.command` + `acp.startupArgs`）
- [ ] roster entry 已加
- [ ] cat-template.json 已同步
- [ ] catId 全局唯一（catalog + template 不冲突）
- [ ] 重启平台后 `@<猫名>` 能正常回复
- [ ] API 日志出现 `ACP session/new: response received`

---

## 参考信息

### CodeBuddy 已验证的自定义模型配置

以下模型已在本机验证可用（走用户自己的 provider key，不走腾讯套餐）：

| 模型 ID | Provider | 端点 | 状态 |
|---------|----------|------|------|
| `qwen3.7-max` | 百炼 | `dashscope.aliyuncs.com/compatible-mode/v1/chat/completions` | ✅ 已验证 |
| `qwen3.7-plus` | 百炼 | 同上 | ✅ 已验证 |
| `glm-5.2` | 智谱 | `open.bigmodel.cn/api/paas/v4/chat/completions` | ✅ 已验证 |
| `glm-5.1` | 智谱 | 同上 | ✅ 已验证 |
| `MiniMax-M3` | 稀宇 | `api.minimaxi.com/v1/chat/completions` | ✅ 已验证 |

### 已验证不可用的模型

| 模型 ID | Provider | 原因 |
|---------|----------|------|
| `DeepSeek-V4-Pro`（大写） | 百炼 | 百炼 API 要求小写 `deepseek-v4-pro` |
| `deepseek-v4-pro`（小写） | 百炼 | 百炼 key 无 DeepSeek 权限（`Model access denied`），需开通 |

### 相关文件路径

| 文件 | 用途 |
|------|------|
| `~/.codebuddy/models.json` | CodeBuddy 自定义模型配置 |
| `~/.codebuddy/settings.json` | CodeBuddy 全局设置 |
| `.cat-cafe/cat-catalog.json` | Clowder 猫配置（运行时） |
| `cat-template.json` | Clowder 猫模板（默认配置） |
| `~/.codebuddy/logs/` | CodeBuddy 日志（排查用） |

### Clowder ACP 框架参考代码

| 关注点 | 文件:行 |
|--------|---------|
| ACP 服务工厂 | `packages/api/src/domains/cats/services/agents/providers/acp/AcpServiceFactory.ts:226` |
| ACP 客户端（spawn + 握手） | `packages/api/src/domains/cats/services/agents/providers/acp/AcpClient.ts:147` |
| ACP 配置接口 | `packages/api/src/config/cat-config-loader.ts:885` (`AcpVariantConfig`) |
| ACP 路由（switch 之前） | `packages/api/src/index.ts:1178` |
| ACP 事件转换器 | `packages/api/src/domains/cats/services/agents/providers/acp/acp-event-transformer.ts` |
| Trae ACP 接入参考 | `.cat-cafe/cat-catalog.json` 的 `trae-acp` breed |
