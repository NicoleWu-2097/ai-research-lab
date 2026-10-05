# ADR 0002：应用模型接口与官方客户端

状态：已接受。日期：2026-10-05。

## 决定

M2 定义应用需要的生成、流式输出、结构化输出和能力错误接口。OpenAI 使用官方 [`openai`](https://github.com/openai/openai-node) SDK，Ollama 使用官方 [`ollama`](https://github.com/ollama/ollama-js) JS 客户端；provider 与模型名由环境配置选择。工作流只依赖应用接口。

## 理由与取舍

两个官方客户端都支持流式调用，但模型能力并不相同。OpenAI [Responses API](https://platform.openai.com/docs/api-reference/responses)提供结构化输出和工具机制；Ollama JS 的接口包含流式、格式和工具字段，具体是否可用取决于所选本地模型。使用单一跨厂商封装可少写适配代码，但容易掩盖能力差异。本项目保留薄适配层和显式能力检查，更容易教学、测试和排错。

## 后果

不硬编码模型。fake provider 是常规测试入口；真实 provider 的能力在 M2 以选定模型实测。缺少所需能力时返回明确错误或选择经验证的降级路径，不静默改变研究逻辑。
