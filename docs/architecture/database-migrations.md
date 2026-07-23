# 数据库迁移与回滚

Kalender 使用 PGlite 保存本地数据。数据库升级采用只增不改的版本化迁移，定义位于
`apps/web/src/server/database.ts`，执行器位于
`apps/web/src/server/database-migrations.ts`。

## 核心约束

- 每个迁移使用严格递增的正整数版本号和稳定名称；
- 已执行迁移记录在 `schema_migrations`，同时保存 SQL 的 SHA-256 校验值；
- 已发布迁移不得修改、重排或删除，只能在列表末尾追加新版本；
- 当前进程的所有待执行迁移在同一个数据库事务中完成；
- 任意迁移失败时，DDL、数据修改和版本记录全部回滚；
- 数据库包含当前应用无法识别的版本，或已执行迁移的校验值变化时，应用拒绝启动并保留数据。

## 启动流程

1. 打开 `.data/postgres`；
2. 创建或读取 `schema_migrations`；
3. 校验已有版本、名称和校验值；
4. 如果旧数据库存在待执行迁移，在 `.data/automatic-backups` 创建
   `pre-migration-v<from>-to-v<to>-<timestamp>.tgz` 和对应 JSON 清单；
5. 在单个事务内按版本顺序执行全部待处理迁移；
6. 提交后应用才开始访问业务表。

全新空数据库不会创建无意义的迁移前快照。已经是最新版本的数据库重复启动不会重复执行
SQL，也不会生成额外快照。

## 状态检查

```powershell
npm run db:migrations:status
```

命令显示当前版本、代码支持的最新版本、待执行版本以及每个已完成迁移的时间和耗时。该命令
会按正常启动规则先完成必要升级。

## 失败与回滚

迁移 SQL 失败时不需要人工回滚：事务会把数据库恢复到启动前状态。应保留错误信息，修复新增
迁移后重新启动。

如果迁移成功但新版本应用出现语义问题：

1. 停止 Kalender 和所有可能打开 PGlite 的进程；
2. 保留当前 `.data/postgres`，不要覆盖或删除；
3. 保留对应的迁移前 `.tgz` 与 JSON 清单；
4. 使用修复后的应用验证快照，或在独立目录通过 PGlite `loadDataDir` 加载快照并检查数据；
5. 只有验证通过后才交换数据库目录；需要回到旧 Schema 时，同时运行兼容该 Schema 的旧应用版本。

迁移前快照只覆盖数据库。草稿附件和主密钥不会被迁移 SQL 修改；完整灾难恢复仍应使用设置页
导出的 ZIP 备份。

## 新增迁移

1. 在 `DATABASE_MIGRATIONS` 末尾追加一个版本；
2. SQL 应尽可能可重复验证，并避免依赖外部网络或文件；
3. 添加旧版本升级测试和失败回滚测试；
4. 运行 `npm run test:database-migrations`、`npm test`、`npm run typecheck` 和生产构建；
5. 不得为了让校验通过而改写已经发布的旧迁移。
