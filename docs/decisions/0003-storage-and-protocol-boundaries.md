# ADR 0003：单库起步，协议按真实边界引入

状态：已接受。日期：2026-10-05。

## 决定

M5 以 PostgreSQL + [pgvector](https://github.com/pgvector/pgvector) 存任务、来源、事件和向量，使用 PostgreSQL 全文检索作为混合检索的起点。M4 用官方 [MCP TypeScript SDK v2](https://github.com/modelcontextprotocol/typescript-sdk) 接真实工具；M8 才用官方 [A2A JS SDK](https://github.com/a2aproject/a2a-js) 将至少两个有独立服务意义的 Agent 连接起来。

## 理由与取舍

pgvector 支持向量检索并能结合 PostgreSQL 全文检索，初期只运行一套数据服务。[Qdrant](https://qdrant.tech/documentation/search/hybrid-queries/) 对密集/稀疏向量混合检索更直接，但还需单独存任务和报告，增加本地服务与数据同步。若 M5/M12 实测显示检索需求超出 pgvector，再重新评估。

MCP 标准化 Agent 到工具/数据的访问；A2A 定义独立 Agent 的发现与任务生命周期。进程内角色调用不需要 A2A。延后引入协议可先验证业务边界，同时在对应阶段进行真实客户端/服务端互操作测试。

## 后果

M1 不启动数据库或协议服务。M5 开始维护 schema、迁移、索引和来源 ID；M9/M10 加入 PostgreSQL 检查点与恢复验证。M4/M8 固定协议版本、权限和兼容性测试。若中文全文检索或混合召回不足，调整检索实现而不改变报告引用契约。
