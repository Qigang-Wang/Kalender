# 飞牛 fnOS Docker 部署

本项目可以直接通过一个 Compose YAML 部署。应用从公开的 GitHub `main` 分支构建，
数据库和应用数据由 Docker 命名卷保存。

**不需要手动 `git clone`，不需要创建数据文件夹，也不需要设置目录权限。**

> 当前配置适合家庭网络或可信局域网。不要在没有 HTTPS 和访问控制的情况下直接
> 暴露到公网。

## 最简单的部署方法

### 1. 准备三个值

需要：

| 名称 | 是否必填 | 用途 |
|---|---|---|
| `KALENDER_POSTGRES_PASSWORD` | 必填 | PostgreSQL 数据库密码 |
| `KALENDER_MASTER_KEY` | 必填 | 加密邮箱、日历和 AI 凭据 |
| `KALENDER_BACKUP_PASSWORD` | 可选 | 自动加密备份 |

可以在任意装有 OpenSSL 的电脑上生成：

```bash
openssl rand -hex 24
openssl rand -base64 32
openssl rand -hex 24
```

三行结果依次对应上面的三个变量。

`KALENDER_MASTER_KEY` 必须长期保存。更换或丢失后，应用无法解密已经保存的账户
凭据。建议将它保存在密码管理器中。

### 2. 在飞牛创建 Compose 项目

1. 打开飞牛 Docker 管理界面。
2. 新建 Compose 项目，项目名填写 `kalender`。
3. 将仓库根目录的 `docker-compose.fnos.yml` 完整粘贴进去。
4. 在 Compose 项目的环境变量区域填写：

```env
KALENDER_POSTGRES_PASSWORD=第一行生成的数据库密码
KALENDER_MASTER_KEY=第二行生成的Base64主密钥
KALENDER_BACKUP_PASSWORD=第三行生成的备份密码
```

5. 点击“构建并启动”。
6. 等待 `postgres` 变为健康，`kalender` 变为运行中。
7. 打开 `http://飞牛局域网IP:3000`。

Docker 会自动创建三个持久化卷：

- `kalender-postgres-data`
- `kalender-data`
- `kalender-backups`

删除或重新构建容器不会删除这些卷中的数据。

## 飞牛界面无法设置环境变量

优先寻找 Compose 项目中的“环境变量”“项目变量”或 `.env` 编辑区域。不同 fnOS
版本的名称可能不同。

也可以直接修改 YAML，但修改后的 YAML 不要上传到公开 GitHub。

将下面两处：

```yaml
${KALENDER_POSTGRES_PASSWORD:?请在.env中设置数据库密码}
```

替换为同一个数据库密码。

将：

```yaml
${KALENDER_MASTER_KEY:?请在.env中设置固定的Base64主密钥}
```

替换为主密钥。

备份密码可以直接写成：

```yaml
KALENDER_BACKUP_PASSWORD: "你的备份密码"
```

Base64 主密钥和备份密码建议使用引号包裹。

## 使用 SSH 部署

SSH 部署只需要一个放置 YAML 和 `.env` 的工作目录，不需要创建数据子目录：

```bash
mkdir -p /vol1/docker/kalender
cd /vol1/docker/kalender
```

下载文件：

```bash
curl -fsSL \
  https://raw.githubusercontent.com/Qigang-Wang/Kalender/main/docker-compose.fnos.yml \
  -o docker-compose.fnos.yml

curl -fsSL \
  https://raw.githubusercontent.com/Qigang-Wang/Kalender/main/.env.fnos.example \
  -o .env
```

编辑 `.env`，填写密码和主密钥：

```bash
nano .env
chmod 600 .env
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
docker compose -f docker-compose.fnos.yml logs --tail=100 kalender
curl -fsS http://127.0.0.1:3000/api/health
```

健康接口应返回：

```json
{"ok":true,"status":"healthy"}
```

## 端口

默认访问端口是 `3000`。如果端口被占用，在项目环境变量或 `.env` 中设置：

```env
KALENDER_HTTP_PORT=3080
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
cd /vol1/docker/kalender
docker compose -f docker-compose.fnos.yml build --pull kalender
docker compose -f docker-compose.fnos.yml up -d kalender
curl -fsS http://127.0.0.1:3000/api/health
```

远程 Git 构建不会自动替换正在运行的容器。代码更新后需要重新构建应用镜像。

如果怀疑使用了旧缓存：

```bash
docker compose -f docker-compose.fnos.yml build --no-cache --pull kalender
docker compose -f docker-compose.fnos.yml up -d kalender
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

`-v` 会删除数据库、附件和服务器备份所使用的 Docker 卷。

## 数据保存在哪里

| Docker 卷 | 容器路径 | 内容 |
|---|---|---|
| `kalender-postgres-data` | `/var/lib/postgresql` | 数据库、账户、邮件索引、日历、任务和设置 |
| `kalender-data` | `/app/.data` | 草稿附件等应用本地文件 |
| `kalender-backups` | `/app/.backups` | 应用生成的 `.backup` 文件 |

查看卷：

```bash
docker volume ls | grep kalender
```

正常更新和重建不会影响这些数据。

## 备份

重大更新前：

1. 打开“设置 > 备份”。
2. 创建加密备份。
3. 等待后台任务完成。
4. 下载备份文件到另一台设备。
5. 单独保存 `KALENDER_MASTER_KEY` 和备份密码。

服务器上的 `kalender-backups` 卷不能作为唯一备份，因为它通常与数据库位于同一台
设备上。

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
docker compose -f docker-compose.fnos.yml logs --tail=200 kalender
```

同时确认飞牛防火墙允许局域网访问端口 `3000`。

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
- `kalender-backups`

### 完全卸载

先下载最终备份，然后停止服务。只有明确不再需要数据时，才在飞牛 Docker 界面手动
删除上述三个卷。
