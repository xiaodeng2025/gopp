# GOPP v1 Conformance

运行 harness 需要 Receiver URL 和 Bearer credential：

`npm run conformance -- --url https://receiver.example.invalid --token <runtime-secret>`

输出包含 PASS / FAIL / SKIP，失败时返回非零退出码。Token 不写入报告。
