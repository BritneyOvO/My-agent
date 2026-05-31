# CTF Agent

这是 z3gh0ne 安全/CTF Agent 项目的 TypeScript 工作区。

当前仓库分为两个互相隔离的部分：

- `backend/`：协作 Hub/API，用于任务交接、审计、策略检查、范围校验、工具调度和多 Agent 协作。
- `backend/match_backend/`：CTF 比赛平台统一后端，提供 CTFd、GZCTF、NSSCTF、攻防世界、CTFPlus 等平台的统一 Python API/CLI。
- `product/`：最终独立安全/CTF Agent 产品原型。该产品本体应与 Hub 运行时解耦，不依赖 Hub 作为核心架构。

## 目录结构

```text
.
├── backend/              # Node.js Hub 后端
│   ├── src/
│   │   ├── core/         # 鉴权、审计、策略、Scope 校验
│   │   ├── lib/          # 环境变量、文件、HTTP、YAML、任务路径工具
│   │   ├── routes/       # health、hub、tasks、reports、tools 路由
│   │   ├── tools/        # 工具注册表和调度器
│   │   └── types/        # 请求 schema 和类型定义
│   ├── match_backend/    # CTF 比赛平台统一 Python 后端
│   └── package.json
├── product/              # 独立 Agent 产品原型
│   └── src/
│       ├── core/         # 规划引擎
│       ├── evidence/     # 证据图
│       └── providers/    # 模型 Provider 抽象
├── config/               # 策略、Scope、工具注册配置
├── docs/                 # 设计与重构文档
├── scripts/              # 验证脚本
└── package.json          # npm workspace 根配置
```

## 环境要求

- 推荐 Node.js 22+
- 推荐 npm 10+

## 安装依赖

```bash
npm install
```

## 常用命令

在仓库根目录执行：

```bash
npm run typecheck   # TypeScript 类型检查
npm run build       # 构建 backend 和 product workspace
npm run smoke       # 构建 backend 并运行 API smoke test
npm run dev         # 构建并以 watch 模式运行 backend
npm run start       # 构建并运行 backend
npm run match:test   # 运行 CTF 平台统一后端 Python 测试
npm run match:api    # 启动 CTF 平台统一后端 API
```

## Backend API

### Hub API

默认端口为 `8080`，可通过 `PORT` 环境变量覆盖。

常用接口：

- `GET /health`
- `GET /hub/info`
- `GET /hub/channels`
- `POST /hub/messages`
- `GET /hub/messages/:channel`
- `POST /tasks`
- `GET /tasks`
- `GET /tasks/:taskId`
- `PATCH /tasks/:taskId/status`
- `POST /tasks/:taskId/comments`
- `POST /tasks/:taskId/artifacts`
- `POST /tasks/:taskId/cancel`
- `GET /reports/:taskId`
- `GET /tools`
- `POST /tools/run`

多数接口需要 Bearer Token：

```http
Authorization: Bearer <Z3GH0NE_ADMIN_TOKEN>
```

### Match Backend API

`backend/match_backend/` 是 Python FastAPI 服务，用于统一访问多个 CTF 平台。

支持的平台：

- `ctfd`
- `gzctf`
- `nssctf`
- `adworld`
- `ctfplus`

启动：

```bash
npm run match:api
```

默认监听：

```text
127.0.0.1:8000
```

也可以直接运行：

```bash
cd backend/match_backend
python3 -m ctf_platforms.server
```

主要接口：

- `GET /health`
- `GET /api/platforms`
- `POST /api/sessions`
- `GET /api/sessions/{session_id}/me`
- `GET /api/sessions/{session_id}/contests`
- `GET /api/sessions/{session_id}/challenges`
- `GET /api/sessions/{session_id}/challenges/{challenge_id}`
- `POST /api/sessions/{session_id}/challenges/{challenge_id}/download`
- `POST /api/sessions/{session_id}/challenges/{challenge_id}/submit`
- `GET /api/sessions/{session_id}/scoreboard`

示例：

```bash
curl -s http://127.0.0.1:8000/api/platforms
```

## 配置说明

主要环境变量：

| 变量 | 用途 | 默认值 |
| --- | --- | --- |
| `PORT` | Backend 监听端口 | `8080` |
| `Z3GH0NE_CONFIG_DIR` | 配置目录 | backend 运行目录的 `../config` |
| `Z3GH0NE_DATA_DIR` | 运行时数据目录 | `backend/.runtime-data` |
| `Z3GH0NE_LOG_DIR` | 运行时日志目录 | `backend/.runtime-logs` |
| `Z3GH0NE_ADMIN_TOKEN` | 管理员 Bearer Token | 空；未配置时鉴权接口返回 503 |
| `Z3GH0NE_LOCAL_AGENT_TOKEN` | 可选 local-agent Token | 空 |
| `Z3GH0NE_UPLOADS_DIR` | 上传文件目录 | `.runtime-data/uploads` |
| `Z3GH0NE_WORKSPACES_DIR` | 工具执行工作目录 | `.runtime-data/workspaces` |

配置文件位于 `config/`：

- `agent-policy.yaml`：允许的模式和阻断关键词
- `allowed-scopes.yaml`：允许访问的目标和范围
- `tool-registry.yaml`：工具白名单、风险等级、超时时间和默认命令

Match Backend 环境变量：

| 变量 | 用途 | 默认值 |
| --- | --- | --- |
| `CTF_PLATFORM_HOST` | Match Backend 监听地址 | `127.0.0.1` |
| `CTF_PLATFORM_PORT` | Match Backend 监听端口 | `8000` |
| `CTF_PLATFORM_DATA_DIR` | Match Backend 运行时数据目录 | `backend/match_backend/.runtime` |

## 安全设计说明

- 工具执行必须经过 `ToolDispatcher`，项目不提供通用裸 shell 执行接口。
- 网络类工具需要经过 Scope 校验。
- Task/Report 文件读取会先校验 `taskId` 必须为 UUID，避免路径穿越。
- 运行时数据、日志、pycache、构建产物、`node_modules` 和 `.external/` 不应进入 Git。
- `backend/match_backend/.runtime/`、`.sessions/`、`downloads/`、`work/`、`.pytest_cache/` 不应进入 Git。
- 不要提交 token、审计日志、handoff 日志、CTF 附件、运行时 workspace 或其他敏感数据。

## 验证流程

提交前建议执行：

```bash
npm run typecheck
npm run build
npm run smoke
npm run match:test
```

正常 smoke 输出类似：

```json
{
  "healthOk": true,
  "unauthToolsStatus": 401,
  "hubUser": "agent",
  "status": "running"
}
```
