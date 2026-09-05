# Publisher Guide

Publisher 需要 Receiver base URL 和 Bearer credential。先调用 `POST /v1/verify`，读取版本、site 和 capabilities；只有能力声明允许时才使用 channels、published、SEO、media 或其他可选字段。

`source_id` 是 Publisher-owned、稳定、不透明的内容身份，位于 `PUT /v1/content/{source_id}` URI；wire 值必须是 1–128 个 ASCII URL unreserved 字符（`A-Z a-z 0-9 - . _ ~`），且不得为 `.` 或 `..`。协议不规定生成算法。重复发送同一内容必须得到 `unchanged`，内容变化得到 `updated`，首次发送得到 `created`，Receiver remote identity 应保持稳定。

生产客户端必须启用 HTTPS/TLS 校验、DNS/SSRF 防护和 redirect blocking。错误应按 Problem Details 处理，并依据 `retryable` 决定是否重试。

显式本地测试可以使用 HTTP，但目标必须是 loopback（`127.0.0.1` 或 `::1`）；不得用测试开关放行任意私网、LAN 或公网 HTTP。Publisher 发送带有 capability-gated 字段前必须先确认 Receiver capabilities。
