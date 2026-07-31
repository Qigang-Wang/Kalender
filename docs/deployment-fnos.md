# Dayline 飞牛 fnOS Docker 部署

本项目可以直接通过一个 Compose YAML 部署。应用从公开的 GitHub `main` 分支构建，
数据库和应用数据由 Docker 命名卷保存，备份文件直接写入飞牛目录。

**不需要手动 `git clone`，不需要 `.env`；只需创建一个可写的备份目录。**

> 当前配置适合家庭网络或可信局域网。不要在没有 HTTPS 和访问控制的情况下直接
> 暴露到公网。

## 最简单的部署方法

### 1. 生成三个密码

需要：

| YAML 字段 | 是否必填 | 用途 |
|---|---|---|
| `database-password` | 必填 | PostgreSQL 数据库密码 |
| `master-key` | 必填 | 加密邮箱、日历和 AI 凭据 |
| `backup-password` | 必填 | 手动和自动加密备份 |
| `backup-directory` | 必填 | 飞牛上保存 `.backup` 文件的绝对路径 |

可以在任意装有 OpenSSL 的电脑上生成：

```bash
openssl rand -hex 24
openssl rand -base64 32
openssl rand -hex 24
```

三行结果依次对应上面的三个变量。

`master-key` 必须长期保存。更换或丢失后，应用无法解密已经保存的账户
凭据。建议将它保存在密码管理器中。

### 2. 修改 YAML 顶部

打开 `docker-compose.fnos.yml`，只替换文件顶部的三个 `CHANGE_ME` 值：

```yaml
x-dayline-settings:
  database-password: &database-password "第一行生成的数据库密码"
  master-key: &master-key "第二行生成的Base64主密钥"
  backup-password: &backup-password "第三行生成的备份密码"
  backup-directory: &backup-directory "/vol1/docker/dayline/backups"
  timezone: &timezone "Europe/Berlin"
```

数据库密码通过 YAML 锚点同时提供给 Dayline 和 PostgreSQL，只需填写一次。备份
目录可以改为其他磁盘或已挂载共享目录的绝对路径。填写后该 YAML 包含明文密码，
不要上传到公开 GitHub。

创建备份目录并授予 Dayline 容器用户写权限：

```bash
mkdir -p /vol1/docker/dayline/backups
chown -R 1001:1001 /vol1/docker/dayline/backups
```

也可以在飞牛文件管理器中创建目录，但仍需确保容器用户 `UID 1001` 可以写入。

### 3. 在飞牛创建 Compose 项目

1. 打开飞牛 Docker 管理界面。
2. 新建 Compose 项目，项目名填写 `dayline`。
3. 将已经填写三个密码的 `docker-compose.fnos.yml` 完整粘贴进去。
4. 点击“构建并启动”。
5. 等待 `postgres` 变为健康，`dayline` 变为运行中。
6. 打开 `http://飞牛局域网IP:8812`。

Dayline 使用 GitHub 源码在飞牛本地构建，不会从 Docker Hub 拉取 `dayline` 镜像；
PostgreSQL 镜像仍会正常从 Docker Hub 下载。

Docker 会自动创建两个持久化卷：

- `kalender-postgres-data`
- `kalender-data`

备份文件保存在 `backup-directory` 指定的飞牛目录。删除或重新构建容器不会删除这些
数据。

## 使用 SSH 部署

SSH 部署需要一个放置 YAML 的工作目录和一个备份目录：

```bash
mkdir -p /vol1/docker/dayline/backups
chown -R 1001:1001 /vol1/docker/dayline/backups
cd /vol1/docker/dayline
```

下载文件：

```bash
curl -fsSL \
  https://raw.githubusercontent.com/Qigang-Wang/Kalender/main/docker-compose.fnos.yml \
  -o docker-compose.fnos.yml
```

编辑 YAML 顶部的三个密码：

```bash
nano docker-compose.fnos.yml
chmod 600 docker-compose.fnos.yml
```

检查 YAML：

```bash
docker compose -f docker-compose.fnos.yml config
```

构建并启动：

```bash
docker compose -f docker-compose.fnos.yml up -d --build
```

检查状态：

```bash
docker compose -f docker-compose.fnos.yml ps
docker compose -f docker-compose.fnos.yml logs --tail=100 dayline
curl -fsS http://127.0.0.1:8812/api/health
```

健康接口应返回：

```json
{"ok":true,"status":"healthy"}
```

## 端口

默认访问端口是 `8812`。如果端口被占用，将 YAML 中的端口映射改为：

```yaml
ports:
  - "8813:3000"
```

然后访问：

```text
http://飞牛局域网IP:3080
```

PostgreSQL 不会映射到飞牛的外部端口，只允许 Compose 内部的应用容器访问。

## 更新应用

先将开发电脑上的新版本推送到 GitHub `main`，然后在飞牛 Compose 项目中选择
“重新构建”或“重新部署”。

SSH 更新命令：

```bash
cd /vol1/docker/dayline
docker compose -f docker-compose.fnos.yml build --pull dayline
docker compose -f docker-compose.fnos.yml up -d dayline
curl -fsS http://127.0.0.1:8812/api/health
```

远程 Git 构建不会自动替换正在运行的容器。代码更新后需要重新构建应用镜像。

如果怀疑使用了旧缓存：

```bash
docker compose -f docker-compose.fnos.yml build --no-cache --pull dayline
docker compose -f docker-compose.fnos.yml up -d dayline
```

## 停止服务

停止容器但保留数据：

```bash
docker compose -f docker-compose.fnos.yml down
```

重新启动：

```bash
docker compose -f docker-compose.fnos.yml up -d
```

**不要执行：**

```bash
docker compose -f docker-compose.fnos.yml down -v
```

`-v` 会删除数据库和附件所使用的 Docker 卷，但不会删除宿主机备份目录。

## 数据保存在哪里

| 存储位置 | 容器路径 | 内容 |
|---|---|---|
| `kalender-postgres-data` | `/var/lib/postgresql` | 数据库、账户、邮件索引、日历、任务和设置 |
| `kalender-data` | `/app/.data` | 草稿附件等应用本地文件 |
| `backup-directory` 指定的飞牛目录 | `/app/.backups` | 应用生成的 `.backup` 文件 |

查看卷：

```bash
docker volume ls | grep kalender
```

正常更新和重建不会影响这些数据。

数据库名、数据库用户和两个命名卷继续使用 `kalender`，这是为了兼容已有部署数据；
应用的 Compose 项目名、服务名和镜像名已经统一为 `dayline`。

## 备份

重大更新前：

1. 打开“设置 > 备份”。
2. 创建加密备份。
3. 等待后台任务完成。
4. 下载备份文件到另一台设备。
5. 单独保存 `KALENDER_MASTER_KEY` 和备份密码。

飞牛上的备份目录不能作为唯一备份，因为它通常仍与数据库位于同一台设备上。建议
再同步到另一块磁盘、另一台 NAS 或其他可信存储。

## 固定版本

默认 YAML 跟随 GitHub `main`：

```yaml
build:
  context: https://github.com/Qigang-Wang/Kalender.git#main
```

正式使用时可以创建 Git 标签，例如 `v0.2.0`，然后改成：

```yaml
build:
  context: https://github.com/Qigang-Wang/Kalender.git#v0.2.0
```

这样重新构建时始终使用固定版本。回滚时改回旧标签并再次构建。

## HTTPS 和 WebSocket

应用页面与实时 WebSocket 共用同一个端口。反向代理需要转发普通 HTTP 请求，并为
`/api/realtime` 启用 WebSocket Upgrade。

没有正确转发 WebSocket 时页面仍能打开，但邮件、日历、任务数量和备份状态不能及时
推送到当前页面。

## 常见问题

### 构建失败

确认飞牛可以访问：

```bash
curl -I https://github.com/Qigang-Wang/Kalender
```

首次构建还需要访问 Docker Hub、npm 和 PostgreSQL 软件源。

### 页面打不开

检查：

```bash
docker compose -f docker-compose.fnos.yml ps
docker compose -f docker-compose.fnos.yml logs --tail=200 dayline
```

同时确认飞牛防火墙允许局域网访问端口 `8812`。

### PostgreSQL 不健康

查看：

```bash
docker compose -f docker-compose.fnos.yml logs --tail=200 postgres
```

常见原因是磁盘空间不足、数据库密码被修改，或者旧数据库卷与新密码不一致。

### 更新后出现空数据

不要重新创建账户。先停止服务并检查命名卷：

```bash
docker compose -f docker-compose.fnos.yml down
docker volume ls | grep kalender
```

确认 Compose 使用的仍然是：

- `kalender-postgres-data`
- `kalender-data`
- YAML 中 `backup-directory` 指定的备份目录

### 完全卸载

先下载最终备份，然后停止服务。只有明确不再需要数据时，才在飞牛 Docker 界面手动
删除上述两个卷，并另外删除 `backup-directory` 指定的目录。
