# 飞牛 fnOS Docker 安装

这套部署通过远程 Git 构建上下文读取 GitHub `main` 分支，因此飞牛上不需要
`git clone` 完整仓库。飞牛只需要保存 `docker-compose.fnos.yml` 和部署密钥。

> 当前版本适合本机或可信局域网。不要在没有 HTTPS、完整认证和访问控制的情况下
> 将端口 `3000` 直接暴露到公网。

## 一、准备条件

- 飞牛已经安装 Docker，并支持 Docker Compose。
- 飞牛可以访问 `github.com`、Docker Hub 和 npm 软件源。
- 至少预留 4 GB 内存和 10 GB 可用磁盘空间用于首次构建。
- GitHub 仓库必须公开。私有仓库需要单独配置 Git 构建认证，不能直接使用本配置。

首次构建会下载 Node.js、PostgreSQL 和 npm 依赖，耗时取决于网络和 NAS 性能。

## 二、生成部署密钥

在飞牛 SSH 终端或其他装有 OpenSSL 的电脑上运行：

```bash
openssl rand -hex 24
openssl rand -base64 32
openssl rand -hex 24
```

三行结果依次用作：

1. `KALENDER_POSTGRES_PASSWORD`
2. `KALENDER_MASTER_KEY`
3. `KALENDER_BACKUP_PASSWORD`

数据库密码使用十六进制字符，能够安全放入 PostgreSQL 连接 URL。主密钥必须长期
保持不变，否则应用无法解密已经保存的邮箱、日历和 AI 凭据。请在密码管理器中另存
一份，主密钥不包含在应用备份中。

## 三、通过飞牛 Docker 界面安装

1. 打开飞牛的 Docker 管理界面。
2. 创建一个 Compose 项目，项目名称保持为 `kalender`。
3. 将仓库根目录的 `docker-compose.fnos.yml` 粘贴到 Compose 编辑器。
4. 在项目环境变量中填写：

```env
KALENDER_POSTGRES_PASSWORD=第一行生成的十六进制密码
KALENDER_MASTER_KEY=第二行生成的Base64主密钥
KALENDER_BACKUP_PASSWORD=第三行生成的备份密码
```

5. 构建并启动 Compose 项目。
6. 等待 `postgres` 显示健康、`kalender` 显示运行中。
7. 浏览器打开 `http://飞牛的局域网IP:3000/today`。

不同 fnOS 版本中的按钮名称可能略有差异。核心操作是保存 Compose YAML、设置三个
环境变量，然后执行“构建并启动”。

## 四、通过 SSH 安装

在飞牛上创建部署目录：

```bash
mkdir -p /vol1/docker/kalender
cd /vol1/docker/kalender
```

将 `docker-compose.fnos.yml` 放入该目录，并创建 `.env`：

```env
KALENDER_POSTGRES_PASSWORD=第一行生成的十六进制密码
KALENDER_MASTER_KEY=第二行生成的Base64主密钥
KALENDER_BACKUP_PASSWORD=第三行生成的备份密码
```

限制密钥文件权限并启动：

```bash
chmod 600 .env
docker compose -f docker-compose.fnos.yml up -d --build
```

查看状态：

```bash
docker compose -f docker-compose.fnos.yml ps
docker compose -f docker-compose.fnos.yml logs --tail=100 kalender
curl -fsS http://127.0.0.1:3000/api/health
```

健康接口返回 `"status":"healthy"` 后即可访问应用。

应用的 HTTP 页面和实时 WebSocket 都使用端口 `3000`，不需要额外开放端口。如果在
飞牛前面配置了 HTTPS 反向代理，请为 `/api/realtime` 启用 WebSocket Upgrade 转发。
未启用时页面仍可使用，但后台邮件、日历、任务和备份状态会退回低频刷新。

## 五、更新应用

先在开发电脑完成测试并将代码推送到 GitHub `main`：

```bash
npm run typecheck
npm test
npm run build
git push origin main
```

然后在飞牛重新构建应用服务：

```bash
cd /vol1/docker/kalender
docker compose -f docker-compose.fnos.yml build kalender
docker compose -f docker-compose.fnos.yml up -d kalender
curl -fsS http://127.0.0.1:3000/api/health
```

远程 Git 构建不会自动更新正在运行的容器。使用飞牛 Docker 界面时，需要对 Compose
项目执行“重新构建”或“重新部署”。数据库容器和持久化卷不会因为应用镜像重建而删除。

如果需要确保完全重新读取依赖和源码，可以执行：

```bash
docker compose -f docker-compose.fnos.yml build --no-cache kalender
docker compose -f docker-compose.fnos.yml up -d kalender
```

## 六、部署固定版本

直接跟随 `main` 适合频繁开发，但正式使用建议发布 Git 标签：

```bash
git tag v0.2.0
git push origin v0.2.0
```

然后将 YAML 中的构建地址改为：

```yaml
build:
  context: https://github.com/Qigang-Wang/Kalender.git#v0.2.0
```

重新构建即可部署该固定版本。回滚时改回之前的标签并再次构建，不需要恢复数据库；
如果新版本执行了不兼容的数据迁移，则应同时使用升级前创建的完整备份恢复。

## 七、数据与备份

配置使用固定名称的三个 Docker Volume：

| Volume | 内容 |
|---|---|
| `kalender-postgres-data` | PostgreSQL 数据库 |
| `kalender-data` | 草稿附件等应用本地文件 |
| `kalender-backups` | 应用生成的备份文件 |

更新应用时不要执行：

```bash
docker compose down -v
```

`-v` 会删除持久化卷。停止服务时使用：

```bash
docker compose -f docker-compose.fnos.yml down
```

重大更新前，在“设置 > 备份”中创建完整备份并下载到另一台设备。还需要单独保管
`KALENDER_MASTER_KEY` 和 `KALENDER_BACKUP_PASSWORD`，只有备份文件不能恢复加密凭据。

如果已经用其他 Compose 项目部署并产生数据，在确认旧 Volume 名称和迁移方案之前，
不要直接切换到这份配置，以免应用连接到一套新的空 Volume。

## 八、常见问题

### GitHub 构建失败

确认仓库公开，并检查飞牛是否可以访问：

```bash
curl -I https://github.com/Qigang-Wang/Kalender
```

如果仓库是私有的，建议使用 GitHub Actions 发布容器镜像，再让飞牛通过
`image: ghcr.io/...` 拉取，不要将 GitHub Token 明文写入 YAML。

### 页面无法访问

检查端口和日志：

```bash
docker compose -f docker-compose.fnos.yml ps
docker compose -f docker-compose.fnos.yml logs --tail=200 kalender
```

确认飞牛防火墙允许局域网访问 TCP `3000`。

### 更新后显示空数据

先停止服务，不要删除任何 Volume。检查 Compose 项目名称以及以下 Volume 是否仍然存在：

```bash
docker volume ls | grep kalender
```

常见原因是更换了 Compose 项目名或 Volume 名，Docker 因而创建了新的空数据卷。
