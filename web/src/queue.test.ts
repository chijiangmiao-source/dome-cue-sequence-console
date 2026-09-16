import { describe, expect, it } from "vitest";
import {
  applyConfirmation,
  buildOp,
  createRefreshGate,
  emptyQueue,
  enqueue,
  mergeServerState,
  nextSeq,
  onRejected,
  reconcile,
  removeOp,
  type PendingOp,
  type QueueState,
} from "./queue";
import type { Confirmation, SessionState } from "./types";

const EPOCH = "epoch-a";

function mkSession(currentSeq: number, confirmed: Confirmation[] = []): SessionState {
  return {
    session_id: "s1",
    name: "测试场",
    epoch: EPOCH,
    current_seq: currentSeq,
    cues: [
      { n: 1, cue_id: "cue-1", label: "一" },
      { n: 2, cue_id: "cue-2", label: "二" },
      { n: 3, cue_id: "cue-3", label: "三" },
    ],
    confirmed,
  };
}

function mkConf(seq: number, op = `op-${seq}`, epoch = EPOCH): Confirmation {
  return {
    session_id: "s1",
    epoch,
    seq,
    cue_id: `cue-${seq}`,
    operation_id: op,
    confirmed_at: "2026-09-16T00:00:00",
  };
}

function mkOp(seq: number, op = `op-${seq}`, epoch = EPOCH): PendingOp {
  return { operation_id: op, epoch, seq, cue_id: `cue-${seq}`, status: "queued" };
}

let idCounter = 0;
const idGen = () => `gen-${++idCounter}`;

describe("buildOp / nextSeq：序号连续递增", () => {
  it("基于服务端游标与本地队列取最大值 +1", () => {
    const server = mkSession(1);
    let q = emptyQueue;
    const op1 = buildOp(server, q, "cue-2", idGen);
    expect(op1.seq).toBe(2);
    q = enqueue(q, op1);
    const op2 = buildOp(server, q, "cue-3", idGen);
    expect(op2.seq).toBe(3);
    q = enqueue(q, op2);
    expect(nextSeq(server, q)).toBe(4);
  });

  it("operation_id 由生成器注入且稳定", () => {
    const server = mkSession(0);
    const op = buildOp(server, emptyQueue, "cue-1", () => "stable-id-1");
    expect(op.operation_id).toBe("stable-id-1");
    expect(op.epoch).toBe(EPOCH);
  });
});

describe("applyConfirmation：迟到/重复响应不得回退画面", () => {
  it("接受紧邻下一条", () => {
    const s = applyConfirmation(mkSession(0), mkConf(1));
    expect(s.current_seq).toBe(1);
    expect(s.confirmed.map((c) => c.seq)).toEqual([1]);
  });

  it("重复确认（同 seq）被忽略", () => {
    const s0 = mkSession(1, [mkConf(1)]);
    const s = applyConfirmation(s0, mkConf(1, "other-op"));
    expect(s).toBe(s0);
  });

  it("同一 operation_id 重放被忽略", () => {
    const s0 = mkSession(1, [mkConf(1, "op-x")]);
    const dup: Confirmation = { ...mkConf(1, "op-x"), seq: 1 };
    expect(applyConfirmation(s0, dup)).toBe(s0);
  });

  it("旧 epoch 的迟到响应不得覆盖新场画面", () => {
    const s0 = mkSession(2, [mkConf(1), mkConf(2)]);
    const late = mkConf(3, "op-late", "epoch-old");
    expect(applyConfirmation(s0, late)).toBe(s0);
  });

  it("跨序号的确认不直接应用（交给全量状态）", () => {
    const s0 = mkSession(0);
    expect(applyConfirmation(s0, mkConf(2))).toBe(s0);
  });
});

describe("mergeServerState：旧快照不得回退", () => {
  it("同 epoch 下拒绝更小的 current_seq", () => {
    const prev = { session: mkSession(3, [mkConf(1), mkConf(2), mkConf(3)]) };
    const next = { session: mkSession(1, [mkConf(1)]) };
    expect(mergeServerState(prev, next)).toBe(prev);
  });

  it("场次切换（epoch 变化）以服务端为准", () => {
    const prev = { session: mkSession(3) };
    const fresh = mkSession(0);
    fresh.epoch = "epoch-b";
    const next = { session: fresh };
    expect(mergeServerState(prev, next)).toBe(next);
  });
});

describe("onRejected：冲突保持待处理并显示期望序号", () => {
  it("gap → 标记冲突并记录 expected_seq", () => {
    const q: QueueState = { pending: [mkOp(1)], isolated: [] };
    const q2 = onRejected(q, "op-1", {
      error: "gap",
      message: "序号不连续",
      cursor: { session_id: "s1", epoch: EPOCH, current_seq: 1 },
      expected_seq: 2,
    });
    expect(q2.pending).toHaveLength(1);
    expect(q2.pending[0].status).toBe("conflict");
    expect(q2.pending[0].expected_seq).toBe(2);
  });

  it("缺 expected_seq 时由游标推导", () => {
    const q: QueueState = { pending: [mkOp(3)], isolated: [] };
    const q2 = onRejected(q, "op-3", {
      error: "gap",
      message: "缺口",
      cursor: { session_id: "s1", epoch: EPOCH, current_seq: 1 },
    });
    expect(q2.pending[0].expected_seq).toBe(2);
  });

  it("stale_epoch → 移入隔离区", () => {
    const q: QueueState = { pending: [mkOp(2)], isolated: [] };
    const q2 = onRejected(q, "op-2", {
      error: "stale_epoch",
      message: "旧场 epoch",
      cursor: { session_id: "s2", epoch: "epoch-b", current_seq: 0 },
    });
    expect(q2.pending).toHaveLength(0);
    expect(q2.isolated).toHaveLength(1);
    expect(q2.isolated[0].operation_id).toBe("op-2");
  });
});

describe("reconcile：以服务端状态校准队列", () => {
  it("operation_id 已被服务端确认 → 出队", () => {
    const server = mkSession(1, [mkConf(1, "op-1")]);
    const q: QueueState = { pending: [mkOp(1), mkOp(2)], isolated: [] };
    const q2 = reconcile(server, q);
    expect(q2.pending.map((o) => o.operation_id)).toEqual(["op-2"]);
  });

  it("旧 epoch 指令被隔离", () => {
    const server = mkSession(0);
    const q: QueueState = {
      pending: [mkOp(1, "op-old", "epoch-old"), mkOp(1, "op-new", EPOCH)],
      isolated: [],
    };
    const q2 = reconcile(server, q);
    expect(q2.pending.map((o) => o.operation_id)).toEqual(["op-new"]);
    expect(q2.isolated.map((o) => o.operation_id)).toEqual(["op-old"]);
  });

  it("序号被他人占用但 operation_id 未确认 → 保持待处理（等待 409 成为冲突项）", () => {
    const server = mkSession(1, [mkConf(1, "someone-else")]);
    const q: QueueState = { pending: [mkOp(1, "op-mine")], isolated: [] };
    const q2 = reconcile(server, q);
    expect(q2.pending).toHaveLength(1);
    expect(q2.pending[0].status).toBe("queued");
  });
});

describe("removeOp", () => {
  it("按 operation_id 出队", () => {
    const q: QueueState = { pending: [mkOp(1), mkOp(2)], isolated: [] };
    expect(removeOp(q, "op-1").pending.map((o) => o.operation_id)).toEqual(["op-2"]);
  });
});

describe("createRefreshGate：切场后旧场迟到快照不得落地", () => {
  it("导入（权威变更）使在途请求失效", () => {
    const gate = createRefreshGate();
    const staleTicket = gate.issue(); // 旧场时代发出的状态请求
    gate.invalidate(); // 导入新场
    expect(gate.accept(staleTicket)).toBe(false); // 迟到旧场快照 → 拒绝
    const freshTicket = gate.issue(); // 新场时代发出的请求
    expect(gate.accept(freshTicket)).toBe(true);
  });

  it("乱序到达：较旧响应不得覆盖较新响应", () => {
    const gate = createRefreshGate();
    const t1 = gate.issue();
    const t2 = gate.issue();
    expect(gate.accept(t2)).toBe(true); // 较新响应先落地
    expect(gate.accept(t1)).toBe(false); // 较旧响应迟到 → 拒绝
  });

  it("同一票据不可重复落地", () => {
    const gate = createRefreshGate();
    const t = gate.issue();
    expect(gate.accept(t)).toBe(true);
    expect(gate.accept(t)).toBe(false);
  });

  it("旧场迟到快照被门禁拒绝 → 新场指令不被误隔离、画面停留新场", () => {
    const gate = createRefreshGate();
    const staleTicket = gate.issue(); // 切场前发出的轮询

    // 新场生效（导入响应已落地）
    gate.invalidate();
    const newSession = mkSession(0);
    newSession.epoch = "epoch-b";
    const queue: QueueState = {
      pending: [mkOp(1, "op-b1", "epoch-b")],
      isolated: [],
    };

    // 旧场快照迟到：门禁拒绝 → 不 setState、不 reconcile
    expect(gate.accept(staleTicket)).toBe(false);

    // 新场时代的正常轮询落地后，新场指令保持待处理、零隔离
    const freshTicket = gate.issue();
    expect(gate.accept(freshTicket)).toBe(true);
    const q2 = reconcile(newSession, queue);
    expect(q2.pending).toHaveLength(1);
    expect(q2.pending[0].epoch).toBe("epoch-b");
    expect(q2.isolated).toHaveLength(0);
  });
});
