# Generic isolated publisher E2E

这是协议层 TEST ONLY 示例：generic input → GOPP Publisher → HTTPS Receiver，验证 `created → unchanged → updated → unchanged`。它不依赖 V5、Tenant、SQLAlchemy、生产数据库、服务器路径、固定域名或内部 commit。真实 URL、Token、local context 与 channel ID 均从环境变量注入。

该示例 intentionally 不模拟某个后台 ORM；应用应自行把已有内容适配为 GOPP content。
