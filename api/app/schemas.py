"""请求/响应模型与推进协议的错误结构。"""

from __future__ import annotations

from pydantic import BaseModel, Field, field_validator


class CueIn(BaseModel):
    """单条提示：编号 n 必须从 1 开始连续递增（在 ImportRequest 中整体校验）。"""

    n: int = Field(ge=1)
    cue_id: str = Field(min_length=1, max_length=200)
    label: str | None = Field(default=None, max_length=500)


class ImportRequest(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    cues: list[CueIn] = Field(min_length=1)

    @field_validator("cues")
    @classmethod
    def _numbering_must_be_consecutive_from_one(cls, cues: list[CueIn]) -> list[CueIn]:
        for pos, cue in enumerate(cues, start=1):
            if cue.n != pos:
                raise ValueError(
                    f"提示编号必须从 1 连续递增：第 {pos} 条提示的编号为 {cue.n}"
                )
        return cues


class AdvanceRequest(BaseModel):
    """推进协议请求：稳定 operation_id + 服务端下发的 epoch + 连续序号 + 提示标识。"""

    operation_id: str = Field(min_length=1, max_length=128)
    epoch: str = Field(min_length=1, max_length=64)
    seq: int = Field(ge=1)
    cue_id: str = Field(min_length=1, max_length=200)


class Cursor(BaseModel):
    """服务端游标：拒绝时返回，供前端对齐/展示期望序号。"""

    session_id: str
    epoch: str
    current_seq: int


class AdvanceOk(BaseModel):
    status: str = "confirmed"
    duplicate: bool
    session_id: str
    epoch: str
    seq: int
    cue_id: str
    operation_id: str
    confirmed_at: str
    current_seq: int
