"""推进协议集成测试：重放、乱序、场次切换、冲突与数据库不变量。

对应验收场景：
- 重放请求（同一 operation_id 重试）→ 返回原确认，不追加记录；
- 交换相邻请求到达顺序 → 先到者被 409 拒绝并返回游标，补齐后按序确认；
- 切换场次 → 旧 epoch 迟到包被隔离，新场确认序列无缺口、无重复。
"""

from __future__ import annotations

import uuid
from concurrent.futures import ThreadPoolExecutor

from conftest import advance, import_session


def test_import_requires_consecutive_numbering(api):
    """提示编号必须从 1 连续递增，否则 422。"""
    bad_cases = [
        [{"n": 1, "cue_id": "a"}, {"n": 3, "cue_id": "b"}],  # 跳号
        [{"n": 2, "cue_id": "a"}],  # 不从 1 开始
        [{"n": 1, "cue_id": "a"}, {"n": 1, "cue_id": "b"}],  # 重复编号
    ]
    for cues in bad_cases:
        r = api.post("/api/sessions/import", json={"name": "非法场", "cues": cues})
        assert r.status_code == 422, r.text
    # 合法载荷恢复可用状态
    import_session(api, "恢复场", 2)


def test_sequential_advance_and_state(api):
    s = import_session(api, "顺序场", 3)
    for seq in (1, 2, 3):
        r = advance(api, s["epoch"], seq, f"cue-{seq}")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["duplicate"] is False
        assert body["seq"] == seq
    state = api.get("/api/state").json()["session"]
    assert state["current_seq"] == 3
    assert [c["seq"] for c in state["confirmed"]] == [1, 2, 3]
    # 越界推进被拒绝
    r = advance(api, s["epoch"], 4, "cue-4")
    assert r.status_code == 409
    assert r.json()["detail"]["error"] == "out_of_range"


def test_replay_same_operation_id_returns_original(api):
    """重放：同一 operation_id 返回原确认，确认记录不增加。"""
    s = import_session(api, "重放场", 3)
    op = uuid.uuid4().hex
    r1 = advance(api, s["epoch"], 1, "cue-1", op)
    assert r1.status_code == 200
    first = r1.json()
    assert first["duplicate"] is False

    r2 = advance(api, s["epoch"], 1, "cue-1", op)
    assert r2.status_code == 200
    second = r2.json()
    assert second["duplicate"] is True
    # 返回的是原确认（确认时间一致）
    assert second["confirmed_at"] == first["confirmed_at"]
    assert second["operation_id"] == op

    state = api.get("/api/state").json()["session"]
    assert state["current_seq"] == 1
    assert len(state["confirmed"]) == 1  # 未追加记录


def test_swap_adjacent_arrival_order(api):
    """乱序：seq2 先到被拒并返回游标，seq1 补齐后 seq2 重试成功。"""
    s = import_session(api, "乱序场", 3)
    op1, op2 = uuid.uuid4().hex, uuid.uuid4().hex

    # seq=2 先到达 → 缺口拒绝，游标指向 current_seq=0、期望 1
    r = advance(api, s["epoch"], 2, "cue-2", op2)
    assert r.status_code == 409
    detail = r.json()["detail"]
    assert detail["error"] == "gap"
    assert detail["cursor"]["current_seq"] == 0
    assert detail["expected_seq"] == 1

    # seq=1 到达 → 确认
    assert advance(api, s["epoch"], 1, "cue-1", op1).status_code == 200
    # seq=2 重试（同一 operation_id）→ 确认
    r = advance(api, s["epoch"], 2, "cue-2", op2)
    assert r.status_code == 200
    assert r.json()["duplicate"] is False

    state = api.get("/api/state").json()["session"]
    assert [c["seq"] for c in state["confirmed"]] == [1, 2]  # 无缺口、无重复


def test_stale_epoch_isolated_after_session_switch(api):
    """切换场次：旧 epoch 迟到包被隔离，旧确认保持隔离、新场序列干净。"""
    a = import_session(api, "旧场", 3)
    op_a1 = uuid.uuid4().hex
    assert advance(api, a["epoch"], 1, "cue-1", op_a1).status_code == 200

    b = import_session(api, "新场", 3)
    assert b["epoch"] != a["epoch"]

    # 旧场新指令（迟到包）→ 409 stale_epoch，游标指向新场
    r = advance(api, a["epoch"], 2, "cue-2")
    assert r.status_code == 409
    detail = r.json()["detail"]
    assert detail["error"] == "stale_epoch"
    assert detail["cursor"]["epoch"] == b["epoch"]
    assert detail["cursor"]["current_seq"] == 0

    # 旧场已确认指令的重放 → 仍返回原确认（幂等），但不影响新场
    r = advance(api, a["epoch"], 1, "cue-1", op_a1)
    assert r.status_code == 200
    assert r.json()["duplicate"] is True

    # 新场推进不受影响，序列从 1 开始无缺口
    assert advance(api, b["epoch"], 1, "cue-1").status_code == 200
    state = api.get("/api/state").json()["session"]
    assert state["epoch"] == b["epoch"]
    assert [c["seq"] for c in state["confirmed"]] == [1]

    # 旧场确认记录保持隔离在原场次下
    old = api.get(f"/api/sessions/{a['session_id']}").json()["session"]
    assert old["status"] == "superseded"
    assert [c["seq"] for c in old["confirmed"]] == [1]


def test_cue_mismatch_rejected_with_expected(api):
    """提示标识不匹配 → 409 并给出期望标识，游标不动。"""
    s = import_session(api, "冲突场", 3)
    r = advance(api, s["epoch"], 1, "wrong-cue")
    assert r.status_code == 409
    detail = r.json()["detail"]
    assert detail["error"] == "cue_mismatch"
    assert detail["expected_cue_id"] == "cue-1"
    assert detail["cursor"]["current_seq"] == 0
    # 正确标识仍可确认
    assert advance(api, s["epoch"], 1, "cue-1").status_code == 200


def test_concurrent_duplicate_replay_single_record(api):
    """并发重放同一 operation_id：全部 200，服务端只有一条确认记录。"""
    s = import_session(api, "并发场", 3)
    op = uuid.uuid4().hex

    def send(_):
        return advance(api, s["epoch"], 1, "cue-1", op)

    with ThreadPoolExecutor(max_workers=8) as pool:
        responses = list(pool.map(send, range(8)))
    assert all(r.status_code == 200 for r in responses)
    assert sum(1 for r in responses if r.json()["duplicate"] is False) <= 1

    state = api.get("/api/state").json()["session"]
    assert len(state["confirmed"]) == 1
    assert state["confirmed"][0]["operation_id"] == op


def test_db_sequence_invariants(api, db):
    """数据库层不变量：活动场次确认序列无缺口、无重复。"""
    s = import_session(api, "终检场", 4)
    ops = [uuid.uuid4().hex for _ in range(4)]
    # 故意乱序 + 重放：seq2 先到被拒，随后补齐
    assert advance(api, s["epoch"], 2, "cue-2", ops[1]).status_code == 409
    for i, seq in enumerate((1, 2, 3, 4)):
        assert advance(api, s["epoch"], seq, f"cue-{seq}", ops[i]).status_code == 200
    # 全部重放一遍 → 不追加记录
    for i, seq in enumerate((1, 2, 3, 4)):
        assert advance(api, s["epoch"], seq, f"cue-{seq}", ops[i]).status_code == 200

    with db.cursor() as cur:
        cur.execute(
            "SELECT current_seq FROM sessions WHERE status = 'active' AND id = %s",
            (s["session_id"],),
        )
        (current_seq,) = cur.fetchone()
        assert current_seq == 4

        cur.execute(
            "SELECT seq FROM confirmations WHERE session_id = %s ORDER BY seq",
            (s["session_id"],),
        )
        seqs = [row[0] for row in cur.fetchall()]
        assert seqs == [1, 2, 3, 4]  # 无缺口、无重复

        cur.execute(
            "SELECT count(*) FROM (SELECT operation_id FROM confirmations "
            "GROUP BY operation_id HAVING count(*) > 1) AS dup"
        )
        assert cur.fetchone()[0] == 0  # operation_id 无重复
