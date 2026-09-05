# Receiver Guide

Receiver 必须提供 Bearer auth、`POST /v1/verify`、`GET /v1/channels`、`PUT /v1/content/{source_id}`，支持 HTML、draft 和稳定 upsert 结果。Receiver 可以写 WordPress、自研 CMS、数据库、静态页或内部 API；这些都不是 GOPP 核心。

Receiver 必须拒绝不符合 wire grammar 的 source_id；content request 顶层、capabilities、site、channel item、成功 response data 和 Problem Details 顶层可忽略未知可选成员，但 content、media、author、seo、field_errors item、channel reference 及成功 envelope 顶层保持严格校验。`content.body` 必须是非空字符串。

`capabilities.statuses` 必须包含 `draft`；published 是可选能力。channels=false 时路由仍存在并返回空数组，且 Publisher 不得发送 channel。对收到的 HTML 应按不可信输入处理并执行适当 sanitization。
