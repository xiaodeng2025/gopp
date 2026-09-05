# Quickstart

## Publisher

安装 Node 依赖后设置 `GOPP_RECEIVER_URL` 与 `GOPP_RECEIVER_TOKEN`，运行 `npm run basic-example`。客户端会先 verify；若 Receiver 声明 channels，则读取栏目；随后 PUT 一条 synthetic content。不要把 Token 写入 URL、代码或日志。

## Receiver

`GOPP_TOKEN=<inject-at-runtime> GOPP_DB_PATH=./test.sqlite GOPP_HOST=127.0.0.1 npm run receiver` 启动本地测试 Receiver。生产 Receiver 必须使用 HTTPS 和安全的凭据注入。

## Conformance

`npm run conformance -- --url https://receiver.example.invalid --token <inject-at-runtime>` 运行兼容性测试；实际使用时通过 secret manager 或受保护的进程环境注入 credential。
