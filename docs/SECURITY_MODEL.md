# GOPP Security Model

- 生产 Receiver URL 必须使用 HTTPS，TLS certificate verification 开启。
- Bearer credential 只能放 Authorization header；不得进入 URL、错误正文、普通日志或测试 fixture。
- Publisher 应解析 DNS 并拒绝 loopback、private、link-local、reserved、multicast、unspecified 目标；混合 public/private 结果 fail closed。
- 重定向默认阻断，避免 Authorization 意外转发到其他主机。
- 本地 loopback bypass 只能由显式测试配置启用，不得扩展为任意私网放行。
- Receiver 必须把输入 HTML 当作不可信内容，在展示前按自身安全策略 sanitization。
- GOPP Bearer credential 与 AI model token、compute token 无关。
