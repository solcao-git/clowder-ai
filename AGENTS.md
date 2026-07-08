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
