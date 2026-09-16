#!/usr/bin/env bash
# 一次性验收：Vitest（前端单元）→ pytest（API 协议集成）→ Playwright（端到端联调）
set -euo pipefail

echo "==> [1/3] Vitest：前端队列 / 推进协议单元测试"
(cd /work/web && npx vitest run)

echo "==> [2/3] pytest：推进协议集成测试（真实 API + PostgreSQL）"
(cd /work/verify && python3 -m pytest tests -v)

echo "==> [3/3] Playwright：浏览器端到端联调"
(cd /work/verify && npx playwright test)

echo "==> 全部验收通过"
