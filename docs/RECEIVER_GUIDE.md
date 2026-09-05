# Receiver Guide

Receiver 必须提供 Bearer auth、`POST /v1/verify`、`GET /v1/channels`、`PUT /v1/content/{source_id}`，支持 HTML、draft 和稳定 upsert 结果。Receiver 可以写 WordPress、自研 CMS、数据库、静态页或内部 API；这些都不是 GOPP 核心。

`capabilities.statuses` 必须包含 `draft`；published 是可选能力。channels=false 时路由仍存在并返回空数组，且 Publisher 不得发送 channel。对收到的 HTML 应按不可信输入处理并执行适当 sanitization。
