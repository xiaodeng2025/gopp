# GOPP Python Publisher

这是与应用无关的 GOPP v1 client。它只处理 Receiver URL、Bearer credential、verify、channels、content、协议错误和传输安全。

生产默认要求 HTTPS、TLS 校验、DNS 目标检查、禁止私有/本地地址、禁止重定向。`allow_loopback=True` 仅用于显式本地测试，不允许任意私网地址。Token 只能通过进程环境或等价 secret injection 提供，不打印、不写 URL、不写日志。

本包不依赖 CMS、数据库、Tenant、V5、FastAPI 或任何 GEO 后台模型。
