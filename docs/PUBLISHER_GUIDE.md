# Publisher Guide

Publisher 需要 Receiver base URL 和 Bearer credential。先调用 `POST /v1/verify`，读取版本、site 和 capabilities；只有能力声明允许时才使用 channels、published、SEO、media 或其他可选字段。

`source_id` 是 Publisher-owned、稳定、不透明的内容身份，位于 `PUT /v1/content/{source_id}` URI；协议不规定生成算法。重复发送同一内容必须得到 `unchanged`，内容变化得到 `updated`，首次发送得到 `created`，Receiver remote identity 应保持稳定。

生产客户端必须启用 HTTPS/TLS 校验、DNS/SSRF 防护和 redirect blocking。错误应按 Problem Details 处理，并依据 `retryable` 决定是否重试。
