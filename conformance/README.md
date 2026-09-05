# GOPP v1 Conformance

运行 harness 需要 Receiver URL 和 Bearer credential：

设置进程环境变量 `GOPP_TOKEN` 后运行 `npm run conformance -- --url https://receiver.example.invalid`。

输出包含 PASS / FAIL / SKIP，失败时返回非零退出码。Token 不写入报告。
