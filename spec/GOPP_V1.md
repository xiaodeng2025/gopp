# GEO Open Publish Protocol（GOPP）v1

## Frozen Draft

本文件为 GOPP v1 Frozen Draft。

Frozen Draft 表示协议已经完成 Phase 0.5 决策冻结，可以进入 Reference Implementation 阶段；不表示协议未来永远不可修改。若实现阶段发现真实不可实现或严重歧义，应通过设计审查提出变更。

本协议是行业无关、后台无关、CMS 无关的网站内容开放推送协议。它规定已经存在的内容如何被识别、传输、能力声明、幂等落地和报告结果，不规定 GEO 平台如何生成内容。

参考对象：牛牛GEO《开放协议 - 官网内容推送》，页面标注版本 v1.1，访问日期 2026-09-04：<https://niugeo.com/open-protocol>。

标准参考：

- HTTP 方法、状态码和幂等语义：[RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html)
- HTTP API 结构化错误：[RFC 9457](https://www.rfc-editor.org/rfc/rfc9457.html)
- Internet 时间戳：[RFC 3339](https://www.rfc-editor.org/rfc/rfc3339)

## 1. 名称和规范性词语

- 正式工作名：GEO Open Publish Protocol
- 简称：GOPP
- 版本：v1，协议版本号使用 1.0
- 当前名称是项目工作名，不代表已完成商标、名称冲突或生态命名审查

“必须（MUST）”“不得（MUST NOT）”“应该（SHOULD）”“可以（MAY）”表示规范强度。其他文字是解释或实现建议。

参与方：

- Publisher：发布方，通常是 GEO 平台或内部标准发布适配层。
- Receiver：客户网站暴露的协议接口，可以由任意语言、框架、CMS 或自研系统实现。
- Content：需要在目标网站创建或更新的逻辑内容。

## 2. v1 核心接口

默认 HTTP binding 如下：

| 能力 | 方法与逻辑路径 | 作用 |
|---|---|---|
| verify | POST /v1/verify | 验证 Receiver、发现协议版本、返回站点信息和 capabilities |
| channels | GET /v1/channels | 获取目标网站自己的栏目/分类 |
| content | PUT /v1/content/{source_id} | 按 source_id 幂等创建或更新内容 |

双方可以为整个 Receiver 配置自定义 base path，例如 https://example.com/content-receiver；但逻辑接口和方法不能改变。部署时可以把版本段放在 base path 中，但最终接口必须能明确识别为 GOPP v1。

content 已冻结为 PUT，而不是 POST。source_id 是目标资源的稳定协议级身份，位于 URI；请求 Body 不重复 source_id，不产生两个独立身份来源。

## 3. 传输和认证

### 3.1 HTTP/JSON

- 生产环境必须使用 HTTPS。
- POST 和 PUT 请求必须使用 Content-Type: application/json，字符集为 UTF-8。
- 客户端应发送 Accept: application/json。
- 成功响应使用 application/json。
- 错误响应使用 application/problem+json，遵循 RFC 9457 的 Problem Details 风格。
- URL 字段必须是绝对 URL；协议不要求 Receiver 一定下载 URL 对应的资源。

### 3.2 Bearer Token

v1 标准认证方式：

~~~http
Authorization: Bearer <token>
~~~

- Receiver 必须支持 Authorization Bearer Header。
- Token 不得出现在 URL、查询参数、错误正文或普通业务日志中。
- Token 的生成、分发、保存、撤销和轮换属于对接部署流程，不属于协议业务模型。
- X-API-Key 不作为 v1 必须实现的第二套标准认证；Receiver 可以作为兼容旧系统的非标准扩展支持，但 Publisher 不得要求所有实现支持。

### 3.3 请求追踪

Publisher 可以发送 X-Request-ID。Receiver 应回显或生成 request_id，但它只负责请求追踪，不负责幂等，也不能替代 source_id。

## 4. 统一成功响应

verify、channels、content 的成功响应使用统一外层：

~~~json
{
  "protocol": "GOPP",
  "protocol_version": "1.0",
  "request_id": "req_01J...",
  "data": {}
}
~~~

- 2xx HTTP 状态码表示请求已按协议处理。
- protocol 必须为 GOPP，protocol_version 必须为 1.0。
- request_id 必须存在。
- data 必须存在；没有专属数据时使用对象 {}。
- content 的创建/更新结果放在 data.result 中，不另造一套成功 envelope。

## 5. 版本兼容

- v1 的主版本边界由 /v1/ 识别。
- verify 成功响应必须返回 GOPP 和 1.0；其他成功响应也应回显。
- 同一主版本后续只能增加可选字段、能力或受治理扩展，不得改变 v1 必填字段语义。
- Receiver 遇到未认识的可选字段，可以忽略并在 warnings 中报告；不得自动把未知字段持久化为内部字段。
- Content request 顶层、capabilities、site、channel item、各成功响应的 data 对象，以及 Problem Details 顶层允许增加未知可选成员；Receiver/Publisher MUST NOT 仅因不认识这些成员而失败。content、request channel reference、media、media item、author、seo、field_errors item 和统一成功 envelope 顶层仍保持严格闭合。
- 未认识的 extension 可以忽略，不得覆盖核心字段语义。
- Publisher 依赖可选能力前必须先读取 capabilities。
- 不支持的主版本必须返回 unsupported_protocol_version，不得静默降级或猜测字段含义。

## 6. verify

### 6.1 请求

~~~http
POST /v1/verify
Authorization: Bearer <token>
Content-Type: application/json

{}
~~~

verify 请求体使用 {}，不得要求 Publisher 暴露 tenant、行业、数据库或内部站点 ID。

### 6.2 语义

verify 是只读的 Receiver 可用性、协议版本和能力验证，至少确认：

1. 请求已通过认证；
2. Receiver 能解析 JSON 和 GOPP v1；
3. Receiver 能返回站点基础信息和 capabilities。

verify 不得创建、修改或删除内容。verify 也不等于数据库写入测试。v1 不定义 dry_run、simulate、preview write 或 test publish；端到端写入测试未来作为独立工具或流程处理。

### 6.3 成功响应

~~~json
{
  "protocol": "GOPP",
  "protocol_version": "1.0",
  "request_id": "req_01JVERIFY",
  "data": {
    "site": {
      "name": "示例企业官网",
      "url": "https://www.example.com",
      "locale": "zh-CN",
      "timezone": "Asia/Shanghai"
    },
    "capabilities": {
      "content_formats": ["html"],
      "statuses": ["draft", "published"],
      "upsert": true,
      "channels": true,
      "tags": true,
      "seo": true,
      "media": true,
      "revision": true,
      "extensions": []
    }
  }
}
~~~

site 只提供站点展示/识别信息，不是租户对象：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| name | string | 否 | 目标网站显示名称 |
| url | absolute URL | 否 | 目标网站公开 URL |
| locale | string | 否 | 站点默认 locale |
| timezone | string | 否 | 站点默认时区 |

capabilities 必须声明 Receiver 当前真实支持的能力，而不是未来计划。

## 7. channels

### 7.1 请求

~~~http
GET /v1/channels
Authorization: Bearer <token>
Accept: application/json
~~~

Receiver 必须提供 GET /v1/channels 路由。无论 capabilities.channels 为 true 还是 false，该路由都必须合法返回统一成功响应；当 channels=false 时，data 必须为 {"channels":[]}，表示 Receiver 没有可映射栏目能力。Publisher SHOULD 在 channels=false 时跳过调用，但不得发送 channel。当 channels=true 时，data.channels 返回目标网站自己的栏目/分类。

### 7.2 成功响应

~~~json
{
  "protocol": "GOPP",
  "protocol_version": "1.0",
  "request_id": "req_01JCHANNELS",
  "data": {
    "channels": [
      {
        "id": "news",
        "name": "新闻中心",
        "parent_id": null
      },
      {
        "id": "technical",
        "name": "技术文章",
        "parent_id": "news"
      }
    ]
  }
}
~~~

当 capabilities.channels=false 时，GET /v1/channels 仍返回统一成功 envelope，且 data 固定为空栏目列表：

~~~json
{
  "protocol": "GOPP",
  "protocol_version": "1.0",
  "request_id": "req_01JEMPTYCHANNELS",
  "data": {
    "channels": []
  }
}
~~~

栏目字段：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| id | string | 是 | Receiver 自己稳定、不透明的栏目 ID；数字 ID 也序列化为字符串 |
| name | string | 是 | 展示和人工映射名称 |
| parent_id | string/null | 否 | 父栏目 ID；根栏目为 null 或省略 |

Publisher 只能依赖 id。name 不能替代 id，也不能把当前 GEO 项目的栏目名定义为协议枚举。层级栏目用 parent_id 表达即可。

v1 明确不加入分页、多语言筛选、搜索和复杂层级查询参数。大规模栏目树的扩展列入 Future Considerations。channels=false 表示“没有栏目能力”，不表示接口不存在。

## 8. content

### 8.1 请求 URI

~~~http
PUT /v1/content/opaque-content-001
Authorization: Bearer <token>
Content-Type: application/json

{
  "title": "如何选择适合企业的服务方案",
  "content": {
    "format": "html",
    "body": "<p>这是正文片段。</p><h2>选择方法</h2><p>……</p>"
  },
  "summary": "一段面向读者的摘要。",
  "media": {
    "cover": {
      "url": "https://cdn.example.com/content/cover.jpg",
      "alt": "企业服务场景"
    },
    "images": [
      {
        "url": "https://cdn.example.com/content/step-1.jpg",
        "alt": "操作步骤示意"
      }
    ]
  },
  "channel": {
    "id": "technical"
  },
  "tags": ["企业服务", "方法论"],
  "author": {
    "name": "示例作者",
    "url": "https://www.example.com/authors/example"
  },
  "seo": {
    "title": "企业服务方案选择指南",
    "description": "帮助企业理解服务方案的选择维度。",
    "keywords": ["企业服务", "服务方案"]
  },
  "source_url": "https://publisher.example.com/content/opaque-content-001",
  "locale": "zh-CN",
  "published_at": "2026-09-04T03:00:00Z",
  "status": "draft",
  "revision": 3,
  "extensions": {}
}
~~~

source_id 不在 Body 中重复。URI 中的 source_id 是唯一权威身份；wire representation 必须是 1–128 个 ASCII URL unreserved 字符（`A-Z a-z 0-9 - . _ ~`），且完整值不得为 `.` 或 `..`。禁止 `/`、反斜杠、`%`、空白、控制字符、Unicode 以及依赖 URL decode 的 percent-encoded 表示。协议不规定 source_id 的生成算法、UUID/哈希格式或是否包含任何内部标识；上游内部 identity 可以是任意格式，Adapter/Publisher 负责稳定映射。

### 8.2 Body 字段

| 字段 | 类型 | 必填 | v1 语义 |
|---|---|---:|---|
| title | string | 是 | 非空内容标题 |
| content | object | 是 | 正文容器 |
| content.format | string | 是 | v1 标准格式为 html |
| content.body | string | 是 | 与 format 对应的非空正文内容；必须是 non-empty string |
| content_type | string | 否 | 泛化类型提示；v1 不规定行业枚举 |
| summary | string | 否 | 内容摘要；协议不要求自动截取 |
| media | object | 否 | cover 和 images，见 8.3 |
| channel | object | 否 | 目标栏目引用，见 8.4 |
| tags | string[] | 否 | 目标站点可使用的标签 |
| author | object | 否 | 个人、组织或署名信息 |
| seo | object | 否 | SEO 元数据 |
| source_url | absolute URL | 否 | 来源内容 URL，不是 Receiver 发布 URL |
| locale | string | 否 | 例如 zh-CN |
| published_at | RFC 3339 timestamp | 否 | 内容时间元数据，不是调度指令 |
| status | enum | 否 | draft 或 published；省略默认为 draft |
| revision | non-negative integer | 否 | 可选上游版本号，见第 11 节 |
| extensions | object | 否 | 受治理的命名空间扩展 |

v1 的 Body 必填字段只有 title、content.format、content.body；资源身份 source_id 必须存在于 URI。Receiver 不得因为缺少可选字段而拒绝一个有效的 v1 请求，但可以拒绝明确发送且不支持的可选能力。`content_type`、`summary`、`author`、`source_url`、`locale`、`published_at` 等没有独立 capability flag 的 optional core fields，只要通过语法和语义校验，Receiver MUST 接受请求；Receiver 可以使用、忽略或附加 warning，但不得仅因内部 CMS/Backend 没有对应字段而拒绝整个 content request。v1 不为这些字段新增 capability flag。

### 8.3 media

~~~json
{
  "media": {
    "cover": {
      "url": "https://example.com/cover.jpg",
      "alt": "封面图替代文本",
      "caption": "可选图注"
    },
    "images": [
      {
        "url": "https://example.com/1.jpg",
        "alt": "正文配图替代文本"
      }
    ]
  }
}
~~~

- url 必须是绝对 http 或 https URL；生产环境建议仅使用 HTTPS。
- Receiver 可以直接引用、下载本地化、上传 CMS Media Library 或使用自己的对象存储。
- 协议不得出现 image_dir、local_path、storage_bucket、image_url_prefix、数据库媒体 ID 或 GEO 内部存储路径。
- Receiver 若下载 URL，应校验协议、重定向、解析后的 IP、大小、超时和内容类型，并防止 SSRF。
- 非核心媒体失败允许内容成功并附带 warnings；核心内容失败必须整体失败。

### 8.4 channel

~~~json
{
  "channel": {
    "id": "technical"
  }
}
~~~

channel.id 必须来自 Receiver channels 返回的目标 ID，且为字符串。可选 name 只能作为诊断快照，不能用于唯一匹配。省略 channel 表示由 Receiver 使用默认归属或不设置栏目。

### 8.5 author 和 SEO

author 可以是个人、组织或署名文本：

~~~json
{
  "author": {
    "name": "某某律师事务所",
    "url": "https://law.example.com/about"
  }
}
~~~

SEO 全部可选：

~~~json
{
  "seo": {
    "title": "页面 SEO 标题",
    "description": "页面 SEO 描述",
    "keywords": ["关键词一", "关键词二"]
  }
}
~~~

SEO 不代表排名、AI 引用或 GEO 效果保证，也不绑定某个 CMS 的列名。

### 8.6 extensions

extensions 只允许命名空间对象，例如：

~~~json
{
  "extensions": {
    "com.example.content-policy": {
      "version": "1"
    },
    "cn.example.feature": {}
  }
}
~~~

规则：

- 扩展必须有稳定命名空间、公开文档、版本和字段语义。`capabilities.extensions` 与 request `extensions` 对象 key 使用同一 namespace 语法；它表示 Receiver 明确认识并支持处理的 namespace。Publisher 若业务逻辑依赖 Receiver 执行某扩展语义，必须先确认该 namespace 已在 capabilities 中声明；未知扩展必须可安全忽略。
- 未知扩展不得导致核心请求失败；Receiver 可以安全忽略。
- 扩展不得覆盖或改变核心字段语义。
- 不允许把 GEO 内部数据库字段、tenant_id、密钥、个人隐私或内部路径整体塞进 extensions。
- 本阶段只定义治理原则，不建立正式扩展注册中心。

## 9. capabilities

verify 返回 Receiver 的实际能力：

~~~json
{
  "capabilities": {
    "content_formats": ["html"],
    "statuses": ["draft", "published"],
    "upsert": true,
    "channels": true,
    "tags": true,
    "seo": true,
    "media": true,
    "revision": true,
    "extensions": []
  }
}
~~~

| 能力 | 类型 | 说明 |
|---|---|---|
| content_formats | string[] | v1 Receiver 至少支持 html；未来格式需有版本/扩展定义 |
| statuses | string[] | 必须包含 draft；可以是 [draft] 或 [draft, published] |
| upsert | boolean | v1 必须为 true；必须返回 created/updated/unchanged |
| channels | boolean | 是否支持 channels 和 channel |
| tags | boolean | 是否接受 tags |
| seo | boolean | 是否接受标准 seo 对象 |
| media | boolean | 是否接受标准 media 对象 |
| revision | boolean | 是否按 v1 revision 规则做乱序/冲突判断 |
| extensions | string[] | 支持的扩展命名空间/标识 |

认证 scope 指 Receiver 识别的稳定逻辑授权主体/发布关系。同一逻辑 identity scope 下仅轮换 Bearer credential，不得使原有 source_id 重新变成 created；协议不规定 Receiver 的内部授权数据库，也不新增 publisher_id 或 tenant 字段。

v1 使用 seo 和 media 的布尔能力表达“标准对象整体可接受”。Receiver 如果只支持其中部分子字段，应在接收时通过 warnings 说明；未来如确有需要，再设计字段级能力扩展。GOPP v1 Receiver 必须支持 draft，capabilities.statuses 必须包含 draft；只声明 [published] 的 Receiver 不符合 GOPP v1。published 是可选能力。

合法的 statuses 声明示例只有以下两类：

~~~json
{
  "statuses": ["draft"]
}
~~~

或：

~~~json
{
  "statuses": ["draft", "published"]
}
~~~

{"statuses":["published"]} 不符合 GOPP v1。

Publisher 必须遵守：

1. 不发送不在 content_formats 中的正文格式。
2. 不发送不在 statuses 中的状态；只有当 capabilities.statuses 包含 published 时，Publisher 才能发送 status=published。
3. 未声明的可选能力尽量不发送；Receiver 不得把 published 静默降级为 draft 后返回完整成功。
4. capabilities 描述当前能力，不得把路线图写成 true。

## 10. content 成功响应

### 10.1 创建

~~~http
HTTP/1.1 201 Created
Content-Type: application/json

{
  "protocol": "GOPP",
  "protocol_version": "1.0",
  "request_id": "req_01JCONTENT",
  "data": {
    "result": "created",
    "remote_id": "123",
    "remote_url": "https://example.com/articles/123",
    "warnings": []
  }
}
~~~

### 10.2 更新或无变化

已有资源更新时返回 200 和 result=updated；请求与当前有效内容没有变化时返回 200 和 result=unchanged。remote_id、remote_url、warnings 均可选。

result 的定义：

- created：该认证作用域内此前不存在此 source_id，已创建。
- updated：已有此 source_id，目标内容有效状态发生变化并已更新。
- unchanged：已有此 source_id，目标内容没有可见变化；不得创建重复内容，也不应执行无意义内容更新。

remote_id 是 Receiver 的不透明目标引用，不得假设它是数据库自增主键。remote_url 是目标内容 URL，不要求所有 Receiver 提供。

### 10.3 warnings 与 errors

warnings 表示内容主体已经按请求成功处理，但一个或多个非核心可选字段没有完全落地。例如封面下载失败：

~~~json
{
  "protocol": "GOPP",
  "protocol_version": "1.0",
  "request_id": "req_01JMEDIA",
  "data": {
    "result": "created",
    "remote_id": "123",
    "warnings": [
      {
        "code": "media_fetch_failed",
        "field": "media.cover.url"
      }
    ]
  }
}
~~~

warnings 不构成一个模糊的“部分成功”状态；结果仍然明确是 created、updated 或 unchanged。title、content.format、content.body 或核心内容写入失败时必须返回 error，不得用 warning 掩盖。

## 11. 幂等、source_id 和 revision

### 11.1 source_id

- source_id 是 URI 中的稳定、不透明资源身份。
- 同一 Publisher→Receiver 认证作用域内，同一 source_id 永远表示同一条逻辑内容。
- 协议不规定生成算法，不要求 UUID、哈希、数据库 ID 或包含 tenant_id。
- 重复 PUT 同一资源不得创建第二条内容。
- 同一个 Receiver 被多个独立 Publisher 共用时，应使用不同凭据/入口隔离作用域，或自行保证 source_id 不冲突。

### 11.2 Receiver 行为

Receiver 必须实现等价于以下语义：

1. 按认证作用域和 URI 中的 source_id 查找逻辑内容；
2. 对同一 source_id 的并发 PUT 执行原子化查找、比较、创建/更新；
3. 首次创建返回 created；
4. 有效内容改变返回 updated；
5. 有效内容不变返回 unchanged；
6. 不要求某种数据库、表结构或唯一索引名称，但必须防止竞态造成重复创建。

PUT 的重复请求可安全重试；第一次可能已经成功，后续请求返回 unchanged 是正常结果。

### 11.3 revision

revision 在 v1 保留，但为 optional、非核心必填：

- 有 revision 时，它必须是同一 source_id 下的非负整数，由 Publisher 在上游内容状态确实变化时递增。
- Receiver 仍必须依靠 source_id 识别资源和保证幂等；revision 不能替代 source_id。
- capabilities.revision=true 时，Receiver 可以按以下规则保护乱序：低于已接受 revision 返回 409 resource_conflict；相同 revision 且内容相同返回 unchanged；相同 revision 但内容不同返回 409 resource_conflict；更高 revision 可以更新。
- capabilities.revision=false 或未声明时，Publisher 不得依赖 Receiver 进行 revision 乱序判断；可以省略 revision。
- revision 不是数据库自增主键、发布时间或请求次数。

### 11.4 content_hash

content_hash 不进入 v1。v1 不自创新的 Hash 一致性协议。HTML 空白、属性顺序、媒体元数据、可选字段和 Receiver 规范化都会影响内容相同性；没有共同规范化规则时，hash 不能可靠替代 Receiver 的有效字段比较。

## 12. 状态模型

v1 标准状态：

| 状态 | 协议语义 |
|---|---|
| draft | Receiver 已接收，但不要求目标内容公开可见 |
| published | Receiver 完成本次请求后，目标内容应进入其系统定义的公开发布状态 |

- status 省略时默认为 draft。
- GOPP v1 Receiver 必须支持 draft，capabilities.statuses 必须包含 draft。
- statuses 合法值为 [draft] 或 [draft, published]；只声明 published 的 Receiver 不符合 GOPP v1。
- Publisher 必须显式发送 published 才能请求公开发布。
- Receiver 只支持 draft 时，应在 capabilities 中声明 [draft]；收到 published 必须报错，不能静默降级。
- published 不要求 HTTP 响应返回瞬间 CDN 已刷新、搜索引擎已收录或静态站点所有节点完成同步。
- published_at 是时间元数据，不触发定时任务。
- v1 不支持 deleted、scheduled、archived、pending、private 或其他 CMS 专有状态。

## 13. HTML 安全基线

v1 不规定具体 Sanitizer 实现，但规定最低安全边界：

- 标准 HTML 内容不应依赖 script。
- 不应允许 javascript: URL。
- 不应允许 inline event handler，例如 onclick。
- 不应允许 object、embed 等主动内容。
- iframe 是否接受，由 Receiver 的能力或安全策略决定。

Receiver 必须按照自己的 CMS、安全模型和运行环境做 HTML sanitize/validation。协议不自行发明完整 HTML 安全标准。

## 14. 错误模型

错误响应统一使用 application/problem+json 和稳定机器码：

~~~json
{
  "type": "about:blank",
  "title": "Invalid content",
  "status": 422,
  "detail": "content.title is required.",
  "instance": "urn:request:req_01JERROR",
  "code": "invalid_content",
  "request_id": "req_01JERROR",
  "field_errors": [
    {
      "field": "title",
      "reason": "required"
    }
  ],
  "retryable": false
}
~~~

- HTTP status 供通用客户端判断大类。
- code 供程序稳定判断；客户端不得解析 detail 做机器逻辑。
- field_errors 可选，用于指出字段路径。
- detail 面向开发者排障，但不得暴露 SQL、堆栈、文件路径、密钥、内部主机或租户信息。
- error 与 warnings 是两种不同结果：error 表示请求未按要求处理；warnings 只能附加在成功响应中表示非核心可选字段问题。

### 14.1 v1 最小错误码

| HTTP | code | 典型含义 | 默认可重试 |
|---:|---|---|---:|
| 400/406 | unsupported_protocol_version | GOPP 主版本不支持 | 否 |
| 400 | invalid_request | JSON、HTTP 方法、URI 或请求结构错误 | 否 |
| 401 | authentication_failed | Token 缺失或无效 | 否，先修复凭据 |
| 404 | channel_not_found | channel.id 不存在 | 否，刷新 channels |
| 409 | resource_conflict | revision/资源状态冲突 | 否，需重新协调 |
| 415/422 | unsupported_content_format | 正文格式不被支持 | 否 |
| 422 | invalid_content | 核心字段或内容语义不合法 | 否 |
| 429 | rate_limited | 触发限流 | 是，遵守 Retry-After |
| 500/503 | internal_error | Receiver 暂时或内部处理失败 | 通常是，需退避 |

错误码保持小而稳定；Receiver 不应为了数据库、框架或内部异常创建几十个公开码。可以用 detail 和 field_errors 提供具体字段信息。

## 15. 重试规则

- PUT 在收到响应前连接中断时可以重试同一 URI 和 Body。
- 4xx 参数、认证、能力错误通常不应重试，除非先修正请求。
- 429、503 以及明确标记 retryable=true 的错误可以退避重试。
- 第一次请求可能已经写入成功，重试返回 unchanged 是正常且成功的幂等结果。
- X-Request-ID 仅做追踪，不承担去重。

## 16. 安全和数据边界

- 生产环境必须 HTTPS。
- Token 不得进入 URL、错误正文和普通日志。
- HTML 是不可信输入；Receiver 必须 sanitize/validate。
- 远程媒体下载必须防 SSRF、重定向攻击、恶意文件、超大文件和过长超时。
- source_id 不能直接作为 SQL、文件路径或命令片段。
- extensions 不能成为内部数据库字段、租户数据或敏感配置外泄通道。
- 限流、IP 白名单、审计、最小数据库权限和 Token 轮换属于部署建议，不改变协议核心。
- Publisher 的显式本地测试绕过只允许 loopback（如 `127.0.0.1`、`::1`）使用 HTTP；不得借此放行任意私网、LAN、metadata 或公网 HTTP。DNS resolve pre-check 是 target validation 与 SSRF 风险降低的 defense-in-depth，不等于完整 connection-level DNS pinning。

## 17. v1 一致性清单

- [ ] POST /v1/verify 使用正确 Token 时返回 GOPP、1.0、站点信息和 capabilities
- [ ] verify 不创建、更新或删除内容
- [ ] Receiver 提供 GET /v1/channels；channels=true 时返回 Receiver 自己的栏目 ID/name
- [ ] channels=false 时 GET /v1/channels 仍合法返回 data={"channels":[]}，Publisher 不发送 channel
- [ ] PUT /v1/content/{source_id} 接受 Body 三个核心必填字段
- [ ] source_id 只以 URI 为权威身份
- [ ] 重复 PUT 不重复创建
- [ ] 重复且有效内容相同返回 unchanged
- [ ] 有效内容变化返回 updated
- [ ] 首次资源返回 created
- [ ] capabilities.statuses 必须包含 draft；published 仅在声明支持时发送
- [ ] 成功响应统一包含 protocol、protocol_version、request_id、data
- [ ] error 与 warnings 清晰区分
- [ ] 未知 extension 可安全忽略
- [ ] 不把相对图片路径、数据库目录或内部租户字段当作协议输入

## 18. Out of Scope / Future Considerations

以下内容不进入 GOPP v1 核心，本阶段只保留方向，不设计实现细节：

- DELETE /content/{source_id}、status=deleted、远端下线、物理删除和恢复
- scheduling、scheduled、callback、webhook、异步任务和投递查询
- batch publish、bulk sync、全量导入和断点续传
- content_hash、跨实现 hash 规范和历史版本
- dry_run、simulate、preview write、test publish
- channel pagination、channel search、多语言筛选和复杂查询
- OAuth、HMAC/RSA 签名、mTLS 和完整凭据轮换协议
- GEO 内容生成逻辑、算力、收费、tenant 业务规则
- GEO 内部质量分、AI metadata、source_trace 和其他内部字段
