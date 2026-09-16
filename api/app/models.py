"""持久化模型：活动场次（含服务端随机 epoch、当前序号）与确认记录。"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    JSON,
    String,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base

# PostgreSQL 上使用 JSONB，SQLite 上退化为普通 JSON，模型层无占位、双端可用。
JsonColumn = JSON().with_variant(JSONB, "postgresql")
# SQLite 仅支持 INTEGER 主键自增，PostgreSQL 使用 BIGINT。
BigIdColumn = BigInteger().with_variant(Integer, "sqlite")


def _new_session_id() -> str:
    return uuid.uuid4().hex


def _new_epoch() -> str:
    """服务端随机 epoch：每次激活场次时生成，旧场迟到包据此被识别隔离。"""
    return uuid.uuid4().hex


class ShowSession(Base):
    __tablename__ = "sessions"
    __table_args__ = (
        # 数据库层保证同一时刻至多一个活动场次。
        Index(
            "ix_sessions_single_active",
            "status",
            unique=True,
            sqlite_where=text("status = 'active'"),
            postgresql_where=text("status = 'active'"),
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_new_session_id)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    epoch: Mapped[str] = mapped_column(
        String(64), nullable=False, unique=True, index=True, default=_new_epoch
    )
    cues: Mapped[list] = mapped_column(JsonColumn, nullable=False)
    current_seq: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="active")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class Confirmation(Base):
    __tablename__ = "confirmations"
    __table_args__ = (
        # 同一场次内序号唯一：从数据库约束上杜绝缺口处的重复占位。
        UniqueConstraint("session_id", "seq", name="uq_confirmations_session_seq"),
    )

    id: Mapped[int] = mapped_column(BigIdColumn, primary_key=True, autoincrement=True)
    session_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("sessions.id"), nullable=False, index=True
    )
    epoch: Mapped[str] = mapped_column(String(64), nullable=False)
    seq: Mapped[int] = mapped_column(Integer, nullable=False)
    cue_id: Mapped[str] = mapped_column(String(200), nullable=False)
    # 稳定 operation_id：幂等键，重试返回原确认而不追加记录。
    operation_id: Mapped[str] = mapped_column(
        String(128), nullable=False, unique=True, index=True
    )
    confirmed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
