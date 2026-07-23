# Kalender AI 集成架构与实施计划

- 文档状态：已确认的开发基线
- 创建日期：2026-07-22
- 适用范围：单用户 Kalender、通过 API 接入多个 AI 服务、每个服务管理多个模型
- 首发提供商：KI Connect / OpenAI-compatible API
- 首发文本模型：`mistral-small-4-119b-2603`、`gpt-oss-120b`
- 首发原则：先完成可靠的配置、读取和建议，再逐步开放受控写入

## 1. 结论摘要

Kalender 的 AI 不应被实现成一个孤立的聊天框，而应成为现有邮件、日历、任务、笔记和关联关系之上的受控协调层。

首版采用以下结构：

```text
AI API 提供商
  ├─ 凭据（服务端加密）
  ├─ Base URL / 协议能力
  └─ 多个模型
       ├─ 模型 ID 与显示名称
       ├─ 能力：流式、工具、结构化输出、Embedding
       ├─ 参数与上下文限制
       └─ 功能绑定：默认对话、规划、摘要、编辑器、Embedding

Kalender AI 请求
  → 选择功能对应的模型
  → 检索最少必要的本地上下文
  → 调用模型
  → 展示答案、来源和操作建议
  → 用户确认高风险操作
  → 复用现有业务仓库执行操作
```

首版模型分工：

- `mistral-small-4-119b-2603`：默认模型，负责 AI Command、跨模块分析、任务拆解和日程规划；
- `gpt-oss-120b`：备用及轻量批处理模型，负责摘要、分类、行动项抽取，并在默认模型失败时回退；
- Embedding 模型：暂不阻塞首版，后续加入语义搜索；
- “Unlimited messages”只视为网页端额度信息，不能假定 API 同样无限。系统仍需记录 API 限流、错误和延迟。

## 2. 当前代码现状

### 2.1 已具备的基础

- PGlite 本地数据库和启动时幂等迁移；
- AES-256-GCM 服务端凭据加密和独立主密钥；
- 邮件、日历、任务、笔记、项目和 `EntityLink` 仓库；
- 邮件正文按需加载，适合落实“最少上下文”原则；
- 邮件草稿、任务、笔记和日历事件的统一 API；
- 全文搜索和 Today 聚合查询；
- 连接测试后保存账户的成熟设置交互；
- 完整 ZIP 备份，可同时保存数据库、主密钥和本地附件；
- Plate 笔记编辑器中已有 AI 菜单、流式 UI 和提示词模板。

### 2.2 当前 AI 功能的缺口

- `/ai` 页面只是静态原型，按钮没有调用真实模型；
- `/api/ai/command` 路由不存在；
- 笔记编辑器在 AI 请求失败时返回随机假文本，会掩盖真实连接错误；
- 编辑器设置中硬编码了大量与实际账户无关的模型；
- 旧设置会把 API Key 从浏览器随每次请求发送，不能作为正式密钥方案；
- 右侧“AI 建议”目前全部是静态文案；
- 没有统一的 Provider、模型路由、工具权限、确认、审计和失败回退；
- 没有对发送给模型的上下文做来源记录、长度预算和敏感内容控制；
- 备份清单尚未统计未来的 AI 配置、会话和操作记录。

因此第一阶段不能直接把某个模型 URL 填进现有假接口，而应先建立正式 AI 基础层。

## 3. 产品原则

1. **一个提供商管理多个模型**：API 地址和凭据属于提供商，模型只保存该 API 下的模型 ID 和能力。
2. **密钥永不返回前端**：前端只能看到“已保存密钥”，不能读取密钥原文。
3. **最少上下文**：默认不上传整个邮箱、全部笔记或完整数据库。
4. **本地检索、远端推理**：先在 PGlite 中筛选，再将少量相关内容发送给模型。
5. **回答必须带来源**：跨模块回答显示使用了哪些邮件、事件、任务和笔记。
6. **模型只提出写操作**：高风险操作必须先形成结构化预览，再由用户确认。
7. **不让模型直接访问数据库**：工具只能调用受验证的服务函数，不能执行任意 SQL 或任意 HTTP。
8. **模型可替换**：业务代码按功能角色选择模型，不在组件和提示词中硬编码模型名。
9. **真实错误可见**：删除假流式回退；连接失败、限流和格式错误必须明确展示。
10. **先前台、后后台**：首版只响应用户主动请求，不自动扫描全部邮件。

## 4. AI 可以用在哪里

### 4.1 AI Command：统一入口

首版核心能力：

- “今天最需要处理的三件事是什么？”
- “总结本周 AMT 项目的邮件、会议、任务和笔记。”
- “把这封邮件中的行动项变成任务，并建议安排时间。”
- “找出下周两个小时的空档。”
- “为明天下午的会议生成准备清单。”

工作方式：

1. 识别用户意图和需要的数据种类；
2. 在本地查询候选实体；
3. 显示即将读取的数据范围，必要时让用户缩小范围；
4. 生成带来源的回答；
5. 将写操作转成操作预览，不直接执行。

### 4.2 Today：首页简报

- 总结今日会议、截止任务、逾期事项和待回复邮件；
- 判断任务与日历是否冲突；
- 根据空档建议专注时间，但不自动修改日历；
- 识别“等待他人”和“阻塞后续”的事项；
- 生成每日开始简报和结束复盘。

首版采用用户点击生成并缓存，不在每次打开页面时自动调用 API。

### 4.3 Inbox：邮件助手

- 单封邮件或线程摘要；
- 提取行动项、截止日期、人员、项目和会议信息；
- 判断是否需要回复以及建议回复时间；
- 生成回复草稿，不自动发送；
- 查找相关任务、事件和笔记；
- 将邮件转为任务并保留来源链接；
- 对德语、英语和中文邮件进行翻译或改写。

上下文策略：列表页只使用主题、发件人和摘要；只有用户打开或明确选择邮件后才读取正文。

### 4.4 Calendar：日程助手

- 将自然语言解析为日程草稿；
- 查找可用时间和冲突；
- 根据任务时长建议时间块；
- 为会议生成会前材料摘要；
- 从会议事件关联邮件和笔记；
- 识别地址、会议链接、时区和全天事件。

创建或修改本地日历事件需要确认；同步到 RWTH 的写入需要更高等级确认。

### 4.5 Tasks：任务助手

- 整理 Inbox 状态任务；
- 拆分复杂任务为下一步；
- 建议截止时间、预计时长、项目和领域；
- 根据截止日期和日历自动计算紧急程度；
- 建议时间块并显示冲突；
- 汇总停滞和等待中的任务。

创建任务可以在用户确认一组操作后批量执行，并使用幂等键防止重复。

### 4.6 Notes：写作和会议助手

- 对选中文本改写、纠错、翻译、缩写和扩写；
- 总结整篇笔记；
- 提取行动项并生成任务草稿；
- 生成会议纪要结构；
- 查找相关邮件、日程和旧笔记；
- 生成项目进展摘要。

现有 Plate AI 菜单可以保留，但模型清单和密钥必须改由服务端配置提供。

### 4.7 全局搜索和关联

第一阶段继续使用现有关键词搜索；第二阶段增加 Embedding：

- 邮件、笔记、任务、事件的语义搜索；
- 自动推荐 `EntityLink`；
- 为 AI Command 提供更相关的上下文；
- Embedding 只在内容变更时增量生成，不每次询问都重算。

## 5. 风险等级和确认策略

| 等级 | 操作 | 默认策略 |
|---|---|---|
| R0 | 搜索、读取、总结、翻译、分类 | 用户发起后自动执行 |
| R1 | 生成回复草稿、计划、任务草稿、日程草稿 | 自动生成预览，不写入外部系统 |
| R2 | 创建或更新本地任务、笔记、关联关系 | 显示变更后一次确认，可提供撤销 |
| R3 | 创建或修改日历、归档邮件、批量修改 | 必须逐组确认，执行前再次检查冲突 |
| R4 | 发送邮件、删除数据、修改 RWTH 远端日历 | 必须明确确认，不允许模型自行继续 |

首版不向模型开放 `send_email`、删除、任意 URL 请求和任意 SQL。

## 6. API 提供商与多模型配置

### 6.1 提供商配置

设置页新增“AI”标签，每个 API 提供商包含：

- 显示名称，例如 `KI Connect`；
- 协议类型：首版为 `OpenAI-compatible`；
- Base URL；
- API Key；
- 可选认证头名称，默认 `Authorization: Bearer`；
- 可选附加请求头，采用白名单键值而非任意脚本；
- 默认超时；
- 启用/暂停状态；
- 最近测试时间、延迟、状态和去敏后的错误；
- 是否允许访问私有网络地址，默认关闭，后续用于 Ollama 等本地模型。

保存流程复用邮件和日历账户模式：

```text
填写配置
  → 测试 API 身份和最小模型调用
  → 展示延迟与能力
  → 测试通过后保存
  → API Key 在服务端加密
```

### 6.2 模型配置

每个提供商下面可以配置多个模型：

- API model ID，例如 `mistral-small-4-119b-2603`；
- 显示名称；
- 模型类型：`chat` 或 `embedding`；
- 是否启用；
- 支持的 endpoint：Chat Completions、Responses 或 Embeddings；
- Streaming、Function Calling、Structured Output、Reasoning、Vision 能力；
- 上下文和最大输出限制；
- 默认 Temperature、TopP、Reasoning Effort；
- 数据处理区域和备注；
- 最近测试结果、首 token 延迟和总延迟。

模型来源支持两种方式：

1. 调用提供商的 `/v1/models` 自动发现；
2. 当服务不提供模型列表时手动增加 model ID。

不能仅依赖 `/v1/models` 声明能力。保存模型时应通过最小请求分别测试 Streaming、工具调用和结构化输出。

### 6.3 功能模型绑定

业务模块不直接保存模型名，而是使用稳定的功能键：

```text
assistant.default       默认对话和一般问答
assistant.planning      复杂规划和跨模块推理
mail.summarize          邮件摘要
mail.extract_actions    行动项抽取
mail.draft_reply        回复草稿
notes.editor            笔记改写
today.briefing          每日简报
search.embedding        语义向量
```

每个功能键可以绑定：

- 主模型；
- 备用模型；
- 最大上下文预算；
- 超时；
- 是否允许工具调用；
- 是否允许回退。

首发建议：

| 功能 | 主模型 | 备用模型 |
|---|---|---|
| 默认对话、规划、回复草稿、笔记编辑 | `mistral-small-4-119b-2603` | `gpt-oss-120b` |
| 摘要、分类、行动项抽取 | `gpt-oss-120b` | `mistral-small-4-119b-2603` |
| Embedding | 后续配置 | 无 |

## 7. 数据模型

### 7.1 核心配置表

```text
ai_providers
- id
- display_name
- provider_kind                 openai-compatible
- base_url
- auth_scheme                   bearer / custom-header
- auth_header_name
- enabled
- allow_private_network
- request_timeout_ms
- last_tested_at
- last_test_status
- last_test_latency_ms
- last_error_code
- created_at
- updated_at

ai_provider_credentials
- provider_id                   FK -> ai_providers
- encrypted_payload             API Key + 允许的附加头
- key_version
- created_at
- updated_at

ai_models
- id
- provider_id                   FK -> ai_providers
- api_model_id
- display_name
- model_kind                    chat / embedding
- endpoint_kind                 chat-completions / responses / embeddings
- enabled
- capabilities                  jsonb
- context_window
- max_output_tokens
- default_parameters            jsonb
- data_region
- last_tested_at
- last_test_status
- last_test_latency_ms
- created_at
- updated_at
- UNIQUE(provider_id, api_model_id, endpoint_kind)

ai_feature_bindings
- feature_key                   PRIMARY KEY
- primary_model_id
- fallback_model_id
- context_budget_tokens
- timeout_ms
- tool_mode
- updated_at
```

### 7.2 会话、运行和操作记录

```text
ai_conversations
- id
- title
- created_at
- updated_at

ai_messages
- id
- conversation_id
- role
- content                       jsonb，保存文本、来源和工具结果
- created_at

ai_runs
- id
- conversation_id              nullable
- feature_key
- provider_id
- model_id
- status                        running / succeeded / failed / cancelled
- prompt_tokens                 nullable
- completion_tokens             nullable
- latency_ms
- error_code                    nullable
- created_at
- finished_at

ai_action_proposals
- id
- run_id
- tool_name
- risk_level
- arguments                     jsonb
- preview                       jsonb
- status                        proposed / approved / executed / rejected / expired / failed
- idempotency_key
- created_at
- decided_at
- executed_at
```

日志不保存 API Key、Authorization、完整原始提示或完整邮件正文。调试时只保存 ID、长度、哈希、模型、耗时和去敏错误。

### 7.3 AI 产物缓存（第二阶段）

```text
ai_artifacts
- id
- artifact_type                 summary / actions / briefing / embedding
- source_kind
- source_id
- source_version_hash
- model_id
- content                       jsonb
- created_at
- expires_at
```

源内容版本未变化时复用摘要，避免重复调用。

## 8. 服务端架构

建议新增以下模块：

```text
server/ai-provider-repository.ts     Provider、凭据和模型持久化
server/ai-provider-validation.ts     URL、模型和参数验证
server/ai-provider-adapter.ts        统一接口
server/openai-compatible-adapter.ts  KI Connect 等兼容服务实现
server/ai-model-router.ts             功能绑定、健康检查和回退
server/ai-context-service.ts          本地检索、裁剪和来源
server/ai-tool-registry.ts            受控工具定义
server/ai-action-service.ts           预览、确认、幂等和执行
server/ai-run-repository.ts           会话、运行与操作记录
server/ai-prompts/                    版本化系统提示
```

Provider 接口：

```ts
interface AiProviderAdapter {
  testConnection(input: TestInput): Promise<TestResult>;
  listModels(signal: AbortSignal): Promise<readonly RemoteModel[]>;
  streamChat(input: ChatInput): Promise<ReadableStream>;
  generateStructured<T>(input: StructuredInput<T>): Promise<T>;
  embed?(input: EmbeddingInput): Promise<readonly number[]>;
}
```

应用内部调用服务模块，不从服务端再次请求自己的 HTTP API。这样所有 AI 工具与普通 UI 共用相同验证、冲突检测和幂等逻辑。

## 9. API 路由规划

### 9.1 配置

```text
GET    /api/ai/providers
POST   /api/ai/providers/test
POST   /api/ai/providers
GET    /api/ai/providers/:providerId
PATCH  /api/ai/providers/:providerId
DELETE /api/ai/providers/:providerId

GET    /api/ai/providers/:providerId/models
POST   /api/ai/providers/:providerId/models/discover
POST   /api/ai/providers/:providerId/models/test
POST   /api/ai/providers/:providerId/models
PATCH  /api/ai/models/:modelId
DELETE /api/ai/models/:modelId

GET    /api/ai/feature-bindings
PUT    /api/ai/feature-bindings/:featureKey
```

测试请求允许输入临时 API Key 或使用已保存的密钥；返回值只包含身份、能力、延迟和公共错误。

### 9.2 对话和操作

```text
POST   /api/ai/chat                         流式 AI Command
POST   /api/ai/editor                       笔记编辑器流式生成
GET    /api/ai/conversations
GET    /api/ai/conversations/:id
DELETE /api/ai/conversations/:id

GET    /api/ai/actions/:actionId
POST   /api/ai/actions/:actionId/approve
POST   /api/ai/actions/:actionId/reject
```

统一流式协议使用 AI SDK 的 UI Message stream；错误必须通过结构化事件返回，不再生成假内容。

## 10. 上下文构建与来源

### 10.1 检索流程

```text
用户问题
  → 意图与实体提示
  → 本地关键词搜索 / 明确选择的对象
  → 按时间、项目、账户和对象类型过滤
  → 排名并去重
  → 按 token 预算裁剪
  → 结构化上下文块
  → 模型回答
```

每个上下文块包含：

- `sourceKind`；
- `sourceId`；
- 标题和必要的正文片段；
- 时间和来源账户；
- 可点击的 Kalender URL；
- `trustedInstructions: false`，明确外部内容不是系统指令。

### 10.2 默认数据范围

- AI Command：用户当前页面、显式选中对象和本地检索 Top N；
- Today：今天前后有限时间窗、未完成任务和最近未读邮件；
- 邮件：当前邮件或线程，必要时才取附件文本；
- 日历：问题涉及的日期范围；
- 任务：未完成任务优先；
- 笔记：当前笔记或明确选择的项目。

界面必须允许用户查看和移除即将发送给 AI 的来源。

## 11. AI 工具设计

### 11.1 首批只读工具

```text
get_today_snapshot
search_workspace
read_mail_message
list_calendar_events
list_tasks
read_note
list_related_entities
```

### 11.2 首批建议和低风险工具

```text
propose_task
propose_note
propose_calendar_event
propose_mail_draft
propose_entity_link
find_free_time
```

这些工具只创建 `ai_action_proposals`，不立即写业务表。

### 11.3 后续执行工具

用户批准后由 `ai-action-service` 调用现有仓库：

```text
create_task
update_task
create_note
update_note
create_calendar_event
update_calendar_event
save_mail_draft
link_entities
```

发送邮件、归档邮件、删除和远端日历写入放到更晚阶段。

## 12. UI 规划

### 12.1 设置 → AI

新增第五个设置标签“AI”：

1. 提供商卡片：名称、状态、Base URL、最近延迟；
2. 新增/编辑表单：API URL、API Key、认证方式、超时；
3. “测试连接”按钮；
4. 提供商下面的模型列表；
5. “发现模型”和“手动添加模型”；
6. 每个模型显示能力、上下文、状态和测试按钮；
7. 功能模型分配区域；
8. 数据隐私说明和“发送最少数据”开关说明；
9. 删除提供商前显示受影响的功能绑定。

### 12.2 AI Command

将现有静态页面改为：

- 会话列表；
- 输入框和数据范围选择；
- 当前模型与回退状态；
- 流式回答；
- 来源卡片；
- 工具调用进度；
- 操作预览与确认；
- 停止生成、重试和切换模型；
- 移动端全屏聊天布局。

### 12.3 模块内入口

- 邮件详情：总结、提取任务、起草回复；
- 日程详情：会议准备、找相关内容、生成任务；
- 任务详情：拆解、安排时间、生成跟进草稿；
- 笔记编辑器：改写、总结、提取任务；
- Today：生成简报；
- 右侧 AssistantPanel：从静态示例改为按需生成的缓存建议。

## 13. 安全和隐私

### 13.1 凭据

- API Key 使用现有主密钥和 AES-256-GCM 加密；
- 加密 AAD 使用 `kalender:ai-provider:<providerId>`，避免与邮箱账户混用；
- 更新时空白 Key 表示保留原密钥；
- 删除提供商时级联删除加密凭据；
- 备份中包含加密凭据和主密钥，因此继续显示“ZIP 未加密”的警告。

### 13.2 网络

- Base URL 必须是有效的 HTTP(S) URL；
- KI Connect 默认要求 HTTPS；
- 禁止凭据随重定向发送到不同主机；
- 限制响应大小、连接时间和总超时；
- 本地/私有地址只有在用户明确开启时允许；
- 自定义 Header 名称和数量使用白名单及长度限制。

### 13.3 Prompt Injection

邮件、日历邀请、笔记和网页内容都按不可信数据处理：

- 系统提示明确要求忽略上下文中的指令；
- 上下文使用结构化边界和来源 ID；
- 外部文本不能增加工具权限；
- 工具参数必须通过 Zod/现有 validation 模块；
- 模型无权改变风险等级或跳过确认；
- 任何要求泄露密钥、系统提示或其他邮件内容的外部文本均被拒绝。

## 14. 可靠性、性能和观测

- 每次运行记录 provider、model、feature、耗时、状态和可用 token 统计；
- 不记录 API Key 和完整敏感正文；
- 对 401/403、429、5xx、超时和格式错误使用稳定错误码；
- 429 尊重 `Retry-After`，交互请求不无限重试；
- 主模型在网络或服务错误时最多回退一次；
- 工具参数验证失败不自动执行，允许模型纠正一次；
- 为用户提供停止生成；
- 同一请求使用 request ID 和幂等键；
- 摘要和简报按源版本缓存；
- 长上下文先本地裁剪，不依赖模型支持的最大窗口兜底。

## 15. 分阶段实施计划

### 阶段 A：AI 配置基础（优先，预计 2–3 个开发回合）

- [x] 新增 AI Provider、凭据、模型和功能绑定表；
- [x] 新增仓库、验证和公共错误模型；
- [x] 实现 OpenAI-compatible adapter；
- [x] 实现连接测试、模型发现、手动添加和能力测试 API；
- [x] 设置页新增 AI 标签；
- [x] 支持一个提供商下面配置多个模型；
- [x] 把 AI 表加入备份计数和恢复验证；
- [x] 测试密钥加密、保留、替换和删除。

实现状态（2026-07-22）：阶段 A 的代码、自动化测试和生产构建均已完成；KI Connect 的模型发现以及 Mistral、GPT OSS 的基础回复、Streaming 和 Function Calling 已使用临时凭据完成真实验收。凭据未写入代码或测试日志，仍需用户在设置页自行加密保存。

完成标准：用户可以配置 KI Connect API，保存两个模型，并分别完成最小流式和 Function Calling 测试。

### 阶段 B：真实流式 AI Command（预计 2–3 个开发回合）

- [x] 实现模型路由和功能绑定；
- [x] 实现 `/api/ai/chat` 流式接口；
- [x] 实现会话和运行记录；
- [x] 将静态 AI Command 改为真实聊天；
- [x] 支持停止、重试、错误和主/备用模型状态；
- [x] 删除随机假流回退；
- [x] 初期只提供纯对话，不读取上下文、不执行写操作。

实现状态（2026-07-22）：阶段 B 已完成。AI Command 使用 AI SDK UI Message stream；主模型只有在尚未输出文本时失败才会回退一次，避免混合两个模型的回答。会话、消息和运行记录保存在本地并纳入备份。

完成标准：Mistral 和 GPT OSS 均可在 AI Command 中流式回答，主模型失败时只回退一次并明确提示。

### 阶段 C：只读上下文与来源（预计 2–3 个开发回合）

- [ ] 实现 `ai-context-service`；
- [ ] 接入 Today、搜索、邮件正文、事件、任务、笔记和关联内容；
- [ ] 实现只读工具；
- [ ] 回答显示来源卡片和跳转；
- [ ] 增加数据范围选择和 token 预算；
- [ ] 加入 Prompt Injection 测试。

完成标准：AI 能回答真实跨模块问题，且用户能看见每条回答使用了哪些本地数据。

### 阶段 D：操作预览和确认（预计 3–4 个开发回合）

- [ ] 新增 `ai_action_proposals`；
- [ ] 实现任务、笔记、日程和草稿建议工具；
- [ ] 实现操作预览、批准、拒绝和过期；
- [ ] 复用现有验证、冲突检测、EntityLink 和幂等机制；
- [ ] 首批开放任务与笔记；
- [ ] 第二批开放日历与邮件草稿；
- [ ] 暂不开放发送和删除。

完成标准：AI 可提出一组可读变更，未经确认不会修改数据，重复确认不会产生重复记录。

### 阶段 E：模块内 AI（预计 3–4 个开发回合）

- [x] Inbox 总结、行动项和回复草稿；
- [ ] Today 每日简报；
- [ ] Calendar 会前准备和空档建议；
- [ ] Tasks 拆解与时间安排；
- [ ] Notes 编辑器接入真实后端；
- [ ] AssistantPanel 改为真实、可刷新、带来源的建议。

实现状态（2026-07-23）：Inbox 已接入按功能模型路由的摘要、行动项和回复草稿；回复编辑器可把用户先写入的要求发送给 AI，并用生成正文替换要求。行动项目前仍是文本结果，结构化任务建议和确认执行属于阶段 D。

完成标准：每个模块至少有一条高频、可日常使用的 AI 工作流。

### 阶段 F：Embedding 和语义检索（后续）

- [ ] 配置 Embedding 模型；
- [ ] 增加内容切分、版本哈希和向量存储；
- [ ] 增量生成 Embedding；
- [ ] 混合关键词和语义排序；
- [ ] 支持跨模块相似内容和自动关联建议。

## 16. 测试计划

### 16.1 单元测试

- Provider URL、模型 ID、参数和 Header 验证；
- API Key 加密、解密、保留和错误主密钥；
- OpenAI-compatible 响应、流和错误解析；
- 模型路由、禁用模型、回退和循环保护；
- token 预算和上下文裁剪；
- 工具 Zod schema、风险等级和幂等键；
- Prompt Injection 和敏感信息去敏。

### 16.2 集成测试

- 假 OpenAI-compatible 服务测试模型发现、Streaming、429 和超时；
- 配置保存后前端无法读取 Key；
- 只读工具不会发生写入；
- 操作批准前后数据库差异；
- 日历冲突和邮件发送安全门；
- 备份导出、清空测试数据库和恢复 AI 配置。

### 16.3 真实验收

- KI Connect Mistral 最小问答；
- KI Connect GPT OSS 最小问答；
- 两个模型的 Streaming；
- 两个模型的 Function Calling；
- 记录真实延迟和限流，而不是假定 API 无限；
- 使用中文、德语和英语邮件测试摘要和行动项；
- 连续使用一周检查重复操作和上下文泄漏。

## 17. 预计修改范围

主要会涉及：

- `apps/web/src/server/database.ts`：AI 表迁移；
- `apps/web/src/server/credential-crypto.ts`：AI Provider AAD 约定；
- `apps/web/src/server/backup-service.ts`：AI 表验证和计数；
- `apps/web/src/server/ai-*`：新增 AI 基础服务；
- `apps/web/src/app/api/ai/**`：配置、聊天和操作路由；
- `apps/web/src/components/workspace-app.tsx`：设置、AI Command 和模块入口；
- `apps/web/src/components/editor/**`：移除浏览器 API Key 和硬编码模型，接入服务端；
- `apps/web/src/app/globals.css`：AI 配置和聊天响应式布局；
- `apps/web/package.json`：加入正式 OpenAI-compatible provider 依赖或实现小型受控适配器。

## 18. 首版不做

- 不让 AI 自主发送邮件；
- 不让 AI 自主删除或归档数据；
- 不自动扫描所有历史邮件；
- 不执行任意 SQL、Shell 或任意 URL 请求；
- 不在前端保存 API Key；
- 不支持未经测试的任意 Provider 私有协议；
- 不在第一阶段建设复杂自治 Agent、多 Agent 或后台自动循环；
- 不把模型最大上下文当作上传全部数据的理由；
- 不承诺网页端“无限消息”等同于 API 无限调用。

## 19. 推荐的下一步

从阶段 A 开始，第一批实现应严格限制为：

1. 设置页 AI 标签；
2. OpenAI-compatible Provider；
3. 服务端加密 API Key；
4. 一个 API 下管理多个模型；
5. Provider 和模型连接测试；
6. Mistral 默认、GPT OSS 备用的功能绑定；
7. AI 配置进入 ZIP 备份恢复。

完成这一步后，再开发真实 AI Command。这样可以先把凭据、模型、错误和备份边界做稳，避免聊天和工具调用建立在临时配置之上。
