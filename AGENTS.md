# Clowder AI — Agent Guide

> ⚠️ 你的身份由 Cat Café L0 编译链注入（cat-catalog.json → compile-system-prompt-l0.mjs → system prompt）。
> 本文件只包含通用安全规则和协作协议，**不定义你是谁**。

## Safety Rules (Iron Laws)
1. **Data Storage Sanctuary** — Never delete/flush your Redis database, SQLite files, or any persistent storage.
2. **Process Self-Preservation** — Never kill your parent process or modify your startup config in ways that prevent restart.
3. **Config Immutability** — Never modify runtime config files. Config changes require human action.
4. **Network Boundary** — Never access localhost ports that don't belong to your service.

## Collaboration Protocol
- Same individual cannot review their own code
- Cross-family review preferred
- Every finding must have a clear severity: P1 (blocking) / P2 (should fix) / P3 (nice to have)

## Truth Sources
- SOP & development flow: `docs/SOP.md`
- Memory routing: `cat-cafe-skills/refs/memory-routing-partial.md`
## GitHub 中文正文编码（PR / Issue / 评论）

- 含中文的 PR、Issue 和评论必须先写入 UTF-8（无 BOM）文件，再使用 `gh ... --body-file <文件>` 或 `gh api ... --input <UTF-8 JSON 文件>` 提交；不要把中文正文直接拼进 PowerShell 参数、管道或 shell 插值。
- PowerShell 生成 JSON 时，使用 `[System.IO.File]::ReadAllText($bodyPath, [System.Text.Encoding]::UTF8)` 读取正文，确认 `body` 是字符串，再用 `[System.IO.File]::WriteAllText($jsonPath, $json, [System.Text.UTF8Encoding]::new($false))` 落盘。
- 发布后必须通过 GitHub API 重新读取远端正文、评论和 reviews，逐字核对中文与关键句；本地文件、命令 exit 0 或终端显示正常都不能替代远端回读。
- 发现乱码或 mojibake 时，编辑原评论/正文后再次回读，禁止新增重复评论；在确认远端文本前，不得声称回复已完成。
