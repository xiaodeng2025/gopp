# GOPP Integration Kit

GOPP（GEO Open Publish Protocol）是行业无关、后台无关、CMS 无关、语言无关的网站内容开放推送协议。它只规定已经存在的内容如何安全、标准化地传输到目标网站，不规定内容生成、AI、租户业务或 CMS 内部实现。

当前协议：GOPP 1.0 Frozen Draft；实现状态：Validated；仓库状态：Release Candidate Preparation。尚未创建公共 release 或发布 package。

## Using an AI coding agent?

先让 agent 阅读 `AGENTS.md`。接入现有 backend 时，可将 `AI_INTEGRATION_CONTEXT.example.md` 复制为本地未跟踪的 `AI_INTEGRATION_CONTEXT.md`，填写事实，然后告诉 agent：阅读这两个文件，检查目标 backend，并在不修改 Frozen Draft 的前提下实现 GOPP。

## Choose your path

- Publisher developer → [Publisher Quickstart](docs/QUICKSTART.md)
- Receiver developer → [Receiver Guide](docs/RECEIVER_GUIDE.md)
- Compatibility testing → [Conformance](conformance/README.md)

核心接口：`POST /v1/verify`、`GET /v1/channels`、`PUT /v1/content/{source_id}`。

## Repository map

- `spec/GOPP_V1.md` — Frozen v1 specification
- `spec/v1/` — JSON Schemas and fixtures
- `publisher/typescript/` — TypeScript client
- `publisher/python/` — Python client
- `receiver/reference/` — protocol reference Receiver
- `examples/` — optional test and usage examples
- `conformance/` — compatibility harness
- `docs/` — implementation guidance

SQLite, health endpoints, browser display pages, and sample channel names are examples only, not protocol requirements.

Python client installation for local development is documented in `publisher/python/pyproject.toml`; it has no dependency on the private V5 integration archive.
