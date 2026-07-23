# CalendarProvider、本地日历与 CalDAV

## 目标

日历业务层只依赖统一的 `CalendarProvider`，不感知事件来自本机、CalDAV、Google Calendar 还是 Microsoft Graph。第一阶段先交付可离线使用的本地个人日历，后续连接器遵循相同契约加入聚合视图。

## 统一契约

`src/mail/types.ts` 定义四个基础操作：

- `listCalendars`：列出可见日历及颜色、只读和主日历状态；
- `listEvents`：按 ISO 时间范围分页读取事件；
- `upsertEvent`：使用同一输入创建或更新事件；
- `deleteEvent`：按日历和事件标识删除。

事件使用 ISO 时间戳传输，并单独保存 IANA 时区和 `allDay` 标记。创建接口接受幂等键，浏览器重试不会重复生成日程。

## 本地实现

PGlite 中的 `calendars` 表保存日历源，`calendar_events` 保存事件。首次初始化会创建 `local:personal` 个人日历；事件外键归属日历，结束时间必须晚于开始时间，并对时间范围建立索引。

服务端 `LocalCalendarProvider` 是仓储层之上的适配器。页面只调用 `/api/calendars` 和 `/api/calendar-events`，不会直接访问数据库。当前 API 面向单机单用户开发版；加入远程访问或多用户前必须补充会话鉴权、CSRF 防护和按用户隔离。

## CalDAV 只读实现

`CalDavCalendarProvider` 使用标准 WebDAV `PROPFIND` 发现 principal、calendar home 和日历集合，使用 `calendar-query REPORT` 按时间范围读取事件。REPORT 请求包含 `expand`，支持服务器展开重复事件实例；ICS 解析器处理全天事件、IANA 时区、参与者、会议 URL、状态、折行和转义文本。

设置页沿用“先测试、后保存”规则。测试只执行身份和日历列表读取，不进行 WebDAV 写操作；成功后凭据通过 AES-256-GCM 写入独立的 `calendar_encrypted_credentials` 表。服务器地址必须使用 HTTPS，并在初始请求及每次跳转前进行公网地址检查，以限制 SSRF 和恶意重定向。

当前同步范围为过去 180 天至未来一年。远端日历和事件写入本地索引，并在 UI 中明确标记为只读；本地日历仍可正常增删改。删除 CalDAV 账户只移除本机凭据和索引，不会删除服务器数据。现阶段提供保存时同步和手动同步，后台定时同步、sync-token/CTag 增量同步及双向写入仍待实现。

## ICS 链接订阅

`ICS` Provider 接受 HTTPS 和 `webcal://` 发布链接，执行 SSRF 地址检查、最多三次安全重定向、5 MB 响应限制以及 `VCALENDAR` 内容校验。完整链接可能包含访问令牌，因此与密码相同使用 AES-256-GCM 加密保存；账户和日历元数据中只保留脱敏地址。订阅会读取过去 180 天至未来一年的日程并写入只读索引，支持保存时同步、手动同步和删除本地连接，不会向发布源写回修改。

## UI 与安全边界

周视图一次读取七天范围，月视图读取覆盖当前月的完整六周网格。周视图按本地时区把事件放置到小时轴并处理重叠，月视图按事件与日期的时间交集展示跨日事件。所有写入都由明确的新建/保存/删除操作触发；删除要求二次确认。右键菜单复用共享命令注册表，`Shift + 右键` 保留浏览器原生菜单。自动化测试只能创建本地测试事件，并在验证结束后删除。

## 后续 Provider 顺序

1. CalDAV 双向写入、sync-token/CTag 增量同步和冲突处理；
2. Google Calendar API：补齐原生增量同步和 Google Meet；
3. Microsoft Graph Calendar：补齐 Outlook / Microsoft 365；
4. 统一重复系列编辑和跨日历移动。
