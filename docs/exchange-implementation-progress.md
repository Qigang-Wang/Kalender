# Exchange 功能实现与验证

本次范围：会议流程、日历字段同步、同步机制、邮件进阶功能。

## 已实现

- 会议：创建并发送邀请；组织者修改、移动、调整时长并发送更新；取消会议并通知；参与者接受、暂定或拒绝并发送回复。发送前在页面确认，服务端校验组织者权限与事件版本。展示参与者角色、回复状态，支持查询参与者忙闲。
- 日历字段：提醒开关、开始时提醒、自定义远端提醒分钟数；空闲、暂定、忙碌、外出、异地工作；富文本段落、加粗、斜体、下划线、删除线、链接和列表。更新参会名单时保留已有必选、可选和资源角色。
- 同步：持久化 SyncFolderItems 游标，失效后恢复；收到变更才重新拉取日历时间窗口，每日刷新窗口。流式通知触发同步，断线退避重连，定时同步兜底。数据入库成功后才提交游标。
- 离线日历：已打开页面断网时，可将新增、修改、移动、调整时长、删除和会议回复暂存到当前用户的浏览器队列。恢复连接后自动提交；待同步事件明确标记、禁止继续叠加修改；失败可重试或撤销本机待同步项。服务端操作回执防止重复执行。
- 邮件：独立的回复与全部回复；转发引用原始正文、文件附件、正文内图片以及作为附件的邮件（EML）；Exchange 草稿创建、编辑、删除、接收远端修改和发送。草稿冲突可选择保留本地或 Exchange 版本，附件先准备完毕，再与正文、同步版本一起提交。

完整构建与 Docker 重建已完成；2026-09-09 服务健康检查返回 HTTP 200。

## 行为边界

- 仍使用已连接邮箱的默认日历；Exchange 重复系列编辑不在本次范围。
- SyncFolderItems 用于检测日历变更；有变更时仍通过 CalendarView 展开重复实例，不是逐条日历事件的增量合并。
- 流式通知和忙闲查询依赖 Exchange 服务器支持与邮箱权限；无法查询的参与者显示为信息不完整，通知不可用时继续定时同步。
- 离线队列需要先打开日历页面。它不是完全离线启动的应用；Exchange 服务单独离线时会显示保存失败。版本冲突或服务器无法确认写入结果时须核对后处理，不能盲目重发会议通知；撤销待同步项只移除本机队列，不撤销远端可能已经完成的操作。
- 富文本只转换上述编辑器支持的格式，不承诺保留任意 Outlook HTML 的全部版式。附件沿用每封最多 10 个、单个 15 MB、总计 25 MB 的限制；无法完整复制时会报错。

## 验证

- `npm run test:exchange-workflows`：模拟 EWS，覆盖邀请与更新字段、通知确认、组织者限制、三种回复、部分忙闲失败、游标提交及恢复、多段通知流、草稿冲突、附件下载期间编辑保护、嵌套邮件附件、回复收件人与附件版本、离线重放去重。
- 已通过现有 calendar、caldav、calendar-sync-scheduler、database-migrations、exchange、exchange-mail、mail-drafts、mail-reply、mail-body、mcp 回归。
- `scripts/test-calendar-drag.mjs`：隔离浏览器服务，覆盖拖动/缩放、迟到的旧刷新、保存失败回退、冲突取消、离线重连和会议回复确认。
- 测试没有向真实参会人或收件人发信。真实服务器上的邀请投递、外部参与者权限与 Outlook 客户端呈现仍需实际使用验证。

协议参考：[会议回复](https://learn.microsoft.com/en-us/exchange/client-developer/web-service-reference/acceptitem)、[会议取消](https://learn.microsoft.com/en-us/exchange/client-developer/web-service-reference/cancelcalendaritem)、[忙闲查询](https://learn.microsoft.com/en-us/exchange/client-developer/web-service-reference/getuseravailability-operation)、[流式通知](https://learn.microsoft.com/en-us/exchange/client-developer/exchange-web-services/how-to-stream-notifications-about-mailbox-events-by-using-ews-in-exchange)、[邮件字段](https://learn.microsoft.com/en-us/exchange/client-developer/web-service-reference/message-ex15websvcsotherref)。
