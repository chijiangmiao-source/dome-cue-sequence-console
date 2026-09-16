"""pytest 公共夹具：真实 HTTP 客户端 + 可选的 PostgreSQL 直连。"""

from __future__ import annotations

import os
import time
import uuid

import httpx
import pytest

API = os.environ.get("API_BASE_URL", "http://localhost:8000")
DSN = os.environ.get("DATABASE_DSN")  # 例：postgresql://show:show@db:5432/showctl


@pytest.fixture(scope="session")
def api() -> httpx.Client:
    with httpx.Client(base_url=API, timeout=10.0) as client:
        # 等待 API 就绪（容器启动竞态）。
        for _ in range(60):
            try:
                if client.get("/api/health").status_code == 200:
                    break
            except httpx.TransportError:
                pass
            time.sleep(1)
        else:
            raise RuntimeError(f"API 未就绪：{API}")
        yield client


def import_session(api: httpx.Client, name: str, n_cues: int = 4) -> dict:
    """导入一个全新场次并返回服务端会话状态（含随机 epoch）。"""
    payload = {
        "name": name,
        "cues": [
            {"n": i + 1, "cue_id": f"cue-{i + 1}", "label": f"提示 {i + 1}"}
            for i in range(n_cues)
        ],
    }
    r = api.post("/api/sessions/import", json=payload)
    assert r.status_code == 201, r.text
    return r.json()["session"]


def advance(
    api: httpx.Client,
    epoch: str,
    seq: int,
    cue_id: str,
    operation_id: str | None = None,
) -> httpx.Response:
    return api.post(
        "/api/advance",
        json={
            "operation_id": operation_id or uuid.uuid4().hex,
            "epoch": epoch,
            "seq": seq,
            "cue_id": cue_id,
        },
    )


@pytest.fixture(scope="session")
def db():
    """直连 PostgreSQL 校验数据库层不变量；无 DSN 时跳过。"""
    if not DSN:
        pytest.skip("未提供 DATABASE_DSN，跳过数据库直连校验")
    import psycopg

    with psycopg.connect(DSN) as conn:
        yield conn
