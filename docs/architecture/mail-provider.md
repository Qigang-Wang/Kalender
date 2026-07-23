# MailProvider 适配层

## 目标

`MailProvider` 把 Gmail、Microsoft 365 和后续 IMAP/CalDAV 的差异隔离在连接器内部。业务层只依赖统一的邮件、日历和增量同步语义。

## 组成

- `types.ts`：账户、授权、邮件、日历、同步游标和能力声明；
- `errors.ts`：跨供应商的统一错误代码和重试信息；
- `registry.ts`：Provider 注册、发现与账户路由；
- `unified-mail-service.ts`：单账户操作和跨账户收件箱聚合；
- `testing/in-memory-mail-provider.ts`：无需外部 API 的契约实现与测试替身。

## 关键边界

### 账户不保存凭据

`ConnectedMailAccount` 只包含业务身份。OAuth 令牌或 IMAP/SMTP 凭据由服务器端凭据存储管理，通过 `ProviderContextFactory` 在执行操作时注入。`ProviderSession` 不得返回浏览器或写入日志。

### 每个账户独立同步

每个账户保存独立的 Provider ID、同步游标和错误状态。Gmail 的 History ID、Microsoft Graph 的 Delta Link 等供应商游标由连接器封装为字符串。

### 能力必须显式声明

Provider 必须声明发送、修改、增量同步、推送通知和日历读写等能力。业务层在调用前检查能力，不能通过捕获供应商特有错误来猜测功能。

### 跨账户分页不共享游标

统一收件箱为每个账户保留独立游标，然后按 `lastMessageAt` 合并排序。一个账户失败时，其他账户仍可返回数据，失败信息随结果一起返回。

### 外部写入使用幂等键

发送邮件和创建日程支持 `idempotencyKey`。真实连接器需要将它映射到供应商能力或本地去重表，避免重试造成重复发送或重复事件。

### 保存账户前必须测试连接

每个 Provider 必须实现 `testConnection(context)`。测试只执行只读探测：验证身份、读取最小邮件元数据，并在支持日历时验证日历读取权限。测试失败不保存账户、不启动同步，也不得把密码或令牌写入日志；成功结果显示已验证身份、检查项目和耗时。

### IMAP/SMTP Provider

通用 Provider 使用 IMAPFlow 读取文件夹、邮件与 UID 增量，使用 Nodemailer 验证 SMTP 并发送邮件，使用 PostalMime 解析 MIME 正文和附件。它支持已读、星标、移动、关键词搜索和 UIDVALIDITY 同步游标；标准 IMAP 没有统一的原生会话模型，因此暂时按单封邮件提供兼容线程。连接强制校验 TLS 证书，限制响应和单封邮件大小，并将认证与网络错误转换为统一错误。

Web 测试端点只接受公网邮件主机，解析 DNS 后拒绝本机、内网、链路本地和保留地址，防止连接测试形成 SSRF。测试同时完成 IMAP 登录/只读文件夹列表和 SMTP `verify`，不会发送邮件。

## 实现新 Provider

1. 实现 `ProviderAuthorizationOperations`；
2. 实现 `MailOperations`；
3. 如支持日历，实现 `CalendarProvider`；
4. 准确填写 `ProviderCapabilities`；
5. 实现只读的 `testConnection`；
6. 把供应商错误映射为 `MailProviderError`；
7. 用同一组契约测试验证连接、分页、同步、发送和错误语义；
8. 在应用启动时注册到 `MailProviderRegistry`。

## 首批真实连接器

建议按以下顺序实现：

1. 通用 IMAP/SMTP Provider（已完成首版）；
2. Microsoft Graph Provider；
3. Gmail Provider；
4. CalDAV Calendar Provider。

具体顺序可根据个人邮箱构成调整。
