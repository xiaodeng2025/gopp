# Implementation Guide

典型链路：`existing backend → adapter → GOPP Publisher → HTTPS → Receiver → CMS/site`。

Adapter 是实现方的责任，用来把已有内容转换为 GOPP content。GOPP 不定义内部 DB、tenant、scheduler、queue、content generation pipeline 或后台 UI。Receiver 可以选择数据库、静态生成或内部 API，只要外部接口遵循 Frozen Spec。
