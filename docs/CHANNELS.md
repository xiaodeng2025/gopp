# Channels

`channel.id` 是 Receiver-owned opaque identifier。Publisher 应先发现并建立显式本地 context → Receiver ID 映射，禁止按名称猜测。GOPP 不定义 `guides`、`news`、行业栏目或任何固定 taxonomy。

当 `capabilities.channels=true`，`GET /v1/channels` 返回实际栏目；当为 false，路由仍必须成功返回 `{"channels":[]}`，Publisher SHOULD 跳过发现且 MUST NOT 发送 `channel`。
