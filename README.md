# 穹幕演出 · 保险台（showctl）

断网重连场景下的导播提示保险台：导入场次 JSON，导播逐条触发提示；断网时指令留在浏览器队列，恢复后按带 **服务端随机 epoch + 连续序号 + 稳定 operation_id** 的推进协议确认，页面只展示服务端已确认项。

## 技术栈

- **API**：Python 3.12 · FastAPI · SQLAlchemy 2 · PostgreSQL 16
- **Web**：TypeScript · React 18 · Vite（生产经 nginx 反代 `/api`）
- **验收**：`verify` 一次性服务 = Vitest（队列纯函数）+ pytest（API 协议集成，真实 PostgreSQL）+ Playwright（浏览器端到端）

## 快速开始

```bash
# 启动应用（宿主端口可用 WEB_PORT / API_PORT 覆盖）
docker compose up -d db api web
#   Web:  http://localhost:${WEB_PORT:-8080}
#   API:  http://localhost:${API_PORT:-8000}/api/state

WEB_PORT=9000 API_PORT=9001 docker compose up -d db api web   # 自定义端口

# 一次性验收（构建并运行全部测试，退出码即验收结果）
docker compose up --exit-code-from verify verify
```

## 场次 JSON 格式

提示编号 `n` 必须从 1 开始连续递增，前后端均校验，违规拒绝导入：

```json
{
  "name": "首场 · 点火仪式",
  "cues": [
    { "n": 1, "cue_id": "open-lights", "label": "全场灯光压暗" },
    { "n": 2, "cue_id": "open-narration", "label": "旁白：开场白" }
  ]
}
```

示例见 `examples/session-sample.json`。

## 推进协议

`POST /api/advance`

```json
{ "operation_id": "稳定UUID", "epoch": "服务端下发的场次epoch", "seq": 3, "cue_id": "open-dome" }
```

- **原子确认**：仅当 `epoch` 属于活动场次、`seq == current_seq + 1` 且 `cue_id` 与该序号提示匹配时，在单事务内写入确认记录并推进游标（`SELECT ... FOR UPDATE` 串行化 + 唯一约束兜底）。
- **幂等重放**：同一 `operation_id` 重试返回原确认（`duplicate: true`），不追加记录。
- **拒绝即返游标**：缺口（`gap`）、提示冲突（`cue_mismatch`）、旧 epoch（`stale_epoch`）均返回 `409`，`detail.cursor` 携带服务端 `{session_id, epoch, current_seq}` 与 `expected_seq`。

前端据此：未确认指令保留在浏览器队列（localStorage 持久化）；冲突项保持待处理并显示期望序号；旧场指令进入隔离区；迟到/重复响应与旧快照一律不得回退画面（单调游标合并）。

## 持久化

- `sessions`：活动场次（部分唯一索引保证至多一个 active）、随机 `epoch`、`current_seq`、提示数组（JSONB）。
- `confirmations`：确认记录，`operation_id` 唯一（幂等键），`(session_id, seq)` 唯一（无缺口无重复）。

## 验收覆盖

| 场景 | 验证层 |
| --- | --- |
| 编号必须从 1 连续递增 | pytest + Vitest |
| 重放同一 operation_id → 原确认、不追加 | pytest（含并发重放）+ Playwright |
| 交换相邻请求到达顺序 → 缺口拒绝、补齐后按序确认 | pytest |
| 切换场次 → 旧 epoch 迟到包隔离、新场序列无缺口 | pytest + Playwright |
| 断网排队、恢复后按序确认 | Playwright（`setOffline`） |
| 冲突项保持待处理并显示期望序号 | Vitest + Playwright |
| 切场后旧场状态快照迟到 → 画面停留新场、新场指令不误隔离 | Vitest + Playwright |
| 数据库不变量（无缺口、无重复 operation_id） | pytest 直连 PostgreSQL |

## 本地开发（无 Docker）

```bash
# API（SQLite 兜底，仅用于本地冒烟；生产为 PostgreSQL）
cd api && pip install -r requirements.txt && uvicorn app.main:app --reload

# Web
cd web && npm ci && npm run dev        # /api 代理到 localhost:8000
cd web && npm test                     # Vitest
```
