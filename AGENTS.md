# GOPP Agent Guide

## Project

GOPP（GEO Open Publish Protocol）通过标准 HTTPS 把 Publisher 中已经存在的内容传给 Receiver。它是 CMS-agnostic、backend-agnostic、industry-agnostic、database-agnostic、language-agnostic、tenant-agnostic。

GOPP 不生成内容，也不定义 AI、prompt、model calls、计费、租户业务、生产工作流、scheduler、queue、delete sync、webhook/callback、batch/bulk、`content_hash` 或 `dry_run`。

## Source of truth

冲突时按以下顺序处理：

1. `spec/GOPP_V1.md`（GOPP 1.0 Frozen Draft）
2. `spec/v1/schemas/`
3. Reference implementation
4. Publisher SDKs
5. Examples
6. README / helper documentation

实现方便不能成为修改 Frozen Draft 的理由。若实现或真实测试暴露协议问题，**STOP AND REPORT**，不要静默修改 Spec。

## GOPP v1 HTTP binding

- `POST /v1/verify`
- `GET /v1/channels`
- `PUT /v1/content/{source_id}`

不要增加 endpoint、字段或另一套规范。

## Key boundaries

- `source_id` 是 stable、opaque、Publisher-owned content identity。协议不规定生成算法，不强制 tenant_id、数据库主键、CMS ID 或业务复合身份。
- `channel.id` 是 Receiver-owned、opaque、stable target ID。`channels=true` 时使用显式 mapping；`channels=false` 时不发送 `channel`。禁止按显示名称猜测，GOPP 不定义行业枚举。
- Publisher 默认要求 HTTPS、TLS verification、DNS/SSRF 防护、拒绝 private/local network、阻断 redirect，并防止 Authorization 泄露。credential 不进 Git、URL、日志。
- 若接入必须弱化这些安全边界，**STOP AND REPORT**。

## Existing backend integration workflow

1. 先读本文件和 `spec/GOPP_V1.md`。
2. 检查目标 backend，确认 canonical content model、title、HTML/body、summary、category/context、status、published time、source URL、media 和稳定 identity。
3. 建立 backend model → GOPP content 的 Adapter。
4. 复用合适的 TypeScript/Python Publisher，保持业务 workflow 与协议分离。
5. 从环境或 secret manager 注入 Receiver URL/credential；channels 必须显式映射。
6. 运行相关 tests/E2E 后再报告完成。

不要为了匹配 backend 而重设计 GOPP。

如果目标 backend 信息不足，先检查代码，不要猜测数据库、framework、tenant model、CMS、article schema 或部署架构。

对真实生产系统默认只读：未经明确授权，不做 migration、生产 DB 写入、删除数据、覆盖配置、重启服务、reload Nginx、修改 TLS/DNS 或修改既有文章。隔离测试资源与既有业务资源必须分开。

## Navigation

- Publisher: `docs/QUICKSTART.md`, `docs/PUBLISHER_GUIDE.md`, `publisher/typescript/`, `publisher/python/`
- Receiver: `docs/RECEIVER_GUIDE.md`, `receiver/reference/`
- Channels: `docs/CHANNELS.md`
- Security: `docs/SECURITY_MODEL.md`
- Compatibility: `conformance/`
- Examples: `examples/`

## Completion checklist

不要宣称 integration complete，除非 protocol mapping explicit、source_id stable、credentials externalized、安全边界 intact、verify 成功、channel handling 符合 capabilities、publish 成功且重复内容不重复创建，并且相关测试通过。理想测试生命周期为 `created → unchanged → updated → unchanged`。

`AI_INTEGRATION_CONTEXT.md` 是本地 implementation context，不是 GOPP extension，也不得进入 wire payload。
