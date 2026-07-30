# AGENTS.md

## 构建

在仓库根目录运行：

```bash
npm run build
```

该命令会先构建核心 TypeScript 代码，再构建 Next.js Web 应用：

```bash
npm run build:core
npm run build:web
```

如果只需要快速做 TypeScript 类型检查，运行：

```bash
npm run typecheck
```

## 重启运行中的服务

如果用户正在通过 `http://localhost:3000` 查看应用，通常对应 Docker Compose 中的 `kalender` 服务。仅运行 `npm run build` 不会更新已经运行的容器；构建后需要自动重建并重启该服务：

```bash
docker compose up -d --build kalender
```

重启后可检查服务状态：

```bash
docker ps
curl -I http://127.0.0.1:3000/api/health
```
