"""穹幕演出保险台 API。

推进协议（POST /api/advance）：
- 仅当 epoch 属于活动场次、序号恰为 current+1 且提示标识匹配时，原子确认；
- 同一 operation_id 重试返回原确认（duplicate=true），不追加记录；
- 缺口 / 提示冲突 / 旧 epoch 一律 409 拒绝，并返回服务端游标。
"""

from __future__ import annotations

import uuid
from typing import Any

from fastapi import Depends, FastAPI, HTTPException
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .db import Base, engine, get_db
from .models import Confirmation, ShowSession
from .schemas import AdvanceOk, AdvanceRequest, ImportRequest

app = FastAPI(title="穹幕演出保险台", version="1.0.0")


@app.on_event("startup")
def _create_tables() -> None:
    Base.metadata.create_all(engine)


# --------------------------------------------------------------------------- #
# 辅助
# --------------------------------------------------------------------------- #

def _cursor(session: ShowSession) -> dict[str, Any]:
    return {
        "session_id": session.id,
        "epoch": session.epoch,
        "current_seq": session.current_seq,
    }


def _reject(code: str, message: str, session: ShowSession | None, **extra: Any) -> None:
    detail: dict[str, Any] = {
        "error": code,
        "message": message,
        "cursor": _cursor(session) if session is not None else None,
    }
    detail.update(extra)
    raise HTTPException(status_code=409, detail=detail)


def _confirmation_payload(conf: Confirmation, *, duplicate: bool) -> AdvanceOk:
    return AdvanceOk(
        duplicate=duplicate,
        session_id=conf.session_id,
        epoch=conf.epoch,
        seq=conf.seq,
        cue_id=conf.cue_id,
        operation_id=conf.operation_id,
        confirmed_at=conf.confirmed_at.isoformat() if conf.confirmed_at else "",
        current_seq=conf.seq,
    )


def _session_payload(db: Session, session: ShowSession) -> dict[str, Any]:
    confs = (
        db.execute(
            select(Confirmation)
            .where(Confirmation.session_id == session.id)
            .order_by(Confirmation.seq)
        )
        .scalars()
        .all()
    )
    return {
        "session_id": session.id,
        "name": session.name,
        "epoch": session.epoch,
        "status": session.status,
        "current_seq": session.current_seq,
        "cues": session.cues,
        "confirmed": [
            {
                "session_id": c.session_id,
                "epoch": c.epoch,
                "seq": c.seq,
                "cue_id": c.cue_id,
                "operation_id": c.operation_id,
                "confirmed_at": c.confirmed_at.isoformat() if c.confirmed_at else "",
            }
            for c in confs
        ],
    }


def _active_session(db: Session, *, lock: bool = False) -> ShowSession | None:
    stmt = select(ShowSession).where(ShowSession.status == "active")
    # SQLite 不支持行锁（单写者已串行化）；PostgreSQL 用 FOR UPDATE 串行化推进。
    if lock and engine.dialect.name != "sqlite":
        stmt = stmt.with_for_update()
    return db.execute(stmt).scalar_one_or_none()


# --------------------------------------------------------------------------- #
# 路由
# --------------------------------------------------------------------------- #

@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/sessions/import", status_code=201)
def import_session(req: ImportRequest, db: Session = Depends(get_db)) -> dict[str, Any]:
    """导入场次 JSON：校验编号连续后激活新场次（新随机 epoch），旧场次被取代。"""
    db.execute(
        update(ShowSession).where(ShowSession.status == "active").values(status="superseded")
    )
    session = ShowSession(
        name=req.name,
        epoch=uuid.uuid4().hex,
        cues=[{"n": c.n, "cue_id": c.cue_id, "label": c.label} for c in req.cues],
        current_seq=0,
        status="active",
    )
    db.add(session)
    db.commit()
    db.refresh(session)
    return {"session": _session_payload(db, session)}


@app.get("/api/state")
def get_state(db: Session = Depends(get_db)) -> dict[str, Any]:
    session = _active_session(db)
    if session is None:
        return {"session": None}
    return {"session": _session_payload(db, session)}


@app.get("/api/sessions/{session_id}")
def get_session(session_id: str, db: Session = Depends(get_db)) -> dict[str, Any]:
    session = db.get(ShowSession, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail={"error": "not_found"})
    return {"session": _session_payload(db, session)}


@app.post("/api/advance")
def advance(req: AdvanceRequest, db: Session = Depends(get_db)) -> AdvanceOk:
    # 1) 幂等重试：同一 operation_id 直接返回原确认，不追加记录。
    existing = db.execute(
        select(Confirmation).where(Confirmation.operation_id == req.operation_id)
    ).scalar_one_or_none()
    if existing is not None:
        return _confirmation_payload(existing, duplicate=True)

    # 2) 锁定活动场次行，序列化并发推进。
    session = _active_session(db, lock=True)
    if session is None:
        _reject("no_active_session", "当前没有活动场次，请先导入场次 JSON", None)

    # 3) 锁内复查幂等键，覆盖并发重试竞态。
    existing = db.execute(
        select(Confirmation).where(Confirmation.operation_id == req.operation_id)
    ).scalar_one_or_none()
    if existing is not None:
        return _confirmation_payload(existing, duplicate=True)

    # 4) epoch 必须属于活动场次：旧场迟到包在此被隔离。
    if req.epoch != session.epoch:
        _reject(
            "stale_epoch",
            "epoch 不属于当前活动场次（场次可能已切换），请求被隔离",
            session,
        )

    # 5) 序号必须恰为 current+1：缺口拒绝并返回服务端游标。
    expected_seq = session.current_seq + 1
    if req.seq != expected_seq:
        _reject(
            "gap",
            f"序号不连续：期望 {expected_seq}，实际 {req.seq}",
            session,
            expected_seq=expected_seq,
        )

    # 6) 提示标识必须匹配该序号。
    cues = session.cues
    if req.seq > len(cues):
        _reject(
            "out_of_range",
            f"序号 {req.seq} 超出提示列表范围（共 {len(cues)} 条）",
            session,
            expected_seq=expected_seq,
        )
    expected_cue_id = cues[req.seq - 1]["cue_id"]
    if req.cue_id != expected_cue_id:
        _reject(
            "cue_mismatch",
            f"提示标识不匹配：序号 {req.seq} 期望 {expected_cue_id}，实际 {req.cue_id}",
            session,
            expected_seq=expected_seq,
            expected_cue_id=expected_cue_id,
        )

    # 7) 原子确认：同事务内写确认记录并推进游标。
    conf = Confirmation(
        session_id=session.id,
        epoch=session.epoch,
        seq=req.seq,
        cue_id=req.cue_id,
        operation_id=req.operation_id,
    )
    db.add(conf)
    session.current_seq = req.seq
    try:
        db.commit()
    except IntegrityError:
        # 兜底：唯一约束冲突（并发重试）时返回原确认。
        db.rollback()
        existing = db.execute(
            select(Confirmation).where(Confirmation.operation_id == req.operation_id)
        ).scalar_one_or_none()
        if existing is not None:
            return _confirmation_payload(existing, duplicate=True)
        raise
    db.refresh(conf)
    return _confirmation_payload(conf, duplicate=False)
