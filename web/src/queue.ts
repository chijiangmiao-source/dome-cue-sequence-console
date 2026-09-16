/**
 * 浏览器端未确认队列的纯函数逻辑。
 *
 * 设计约束（与验收对应）：
 * - 断网时指令留在浏览器队列，页面只展示服务端已确认项；
 * - 迟到/重复响应不得回退画面（applyConfirmation / mergeServerState 的单调性）；
 * - 同一 operation_id 重试由服务端幂等返回，前端据此移除队列项；
 * - 缺口/冲突 → 保持待处理并记录期望序号；旧 epoch → 隔离。
 */

import type {
  Confirmation,
  RejectDetail,
  SessionState,
  StateResponse,
} from "./types";

export type PendingStatus = "queued" | "conflict";

export interface PendingOp {
  operation_id: string;
  epoch: string;
  seq: number;
  cue_id: string;
  status: PendingStatus;
  /** 冲突时服务端给出的期望序号。 */
  expected_seq?: number;
  note?: string;
}

export interface QueueState {
  /** 活动场次的未确认指令（按 seq 升序）。 */
  pending: PendingOp[];
  /** 旧场迟到包：被隔离，永不重放。 */
  isolated: PendingOp[];
}

export const emptyQueue: QueueState = { pending: [], isolated: [] };

/** 下一条可触发的序号：服务端游标与本地队列的较大者 +1。 */
export function nextSeq(server: SessionState, q: QueueState): number {
  const maxPending = q.pending
    .filter((o) => o.epoch === server.epoch)
    .reduce((m, o) => Math.max(m, o.seq), 0);
  return Math.max(server.current_seq, maxPending) + 1;
}

/** 构造一条待确认指令（operation_id 由注入的生成器保证稳定唯一）。 */
export function buildOp(
  server: SessionState,
  q: QueueState,
  cueId: string,
  idGen: () => string,
): PendingOp {
  return {
    operation_id: idGen(),
    epoch: server.epoch,
    seq: nextSeq(server, q),
    cue_id: cueId,
    status: "queued",
  };
}

export function enqueue(q: QueueState, op: PendingOp): QueueState {
  return {
    ...q,
    pending: [...q.pending, op].sort((a, b) => a.seq - b.seq),
  };
}

export function removeOp(q: QueueState, operationId: string): QueueState {
  return { ...q, pending: q.pending.filter((o) => o.operation_id !== operationId) };
}

export function discardOp(q: QueueState, operationId: string): QueueState {
  return {
    pending: q.pending.filter((o) => o.operation_id !== operationId),
    isolated: q.isolated.filter((o) => o.operation_id !== operationId),
  };
}

/**
 * 应用一条确认响应：只前进、不回退。
 * - 旧 epoch 的迟到响应不得覆盖新场画面；
 * - 已确认过的序号/operation_id 直接忽略；
 * - 只接受紧邻下一条，跨序号的缺口交给全量状态刷新兜底。
 */
export function applyConfirmation(
  server: SessionState,
  conf: Confirmation,
): SessionState {
  if (conf.epoch !== server.epoch) return server;
  if (conf.seq <= server.current_seq) return server;
  if (conf.seq !== server.current_seq + 1) return server;
  if (server.confirmed.some((c) => c.operation_id === conf.operation_id)) {
    return server;
  }
  return {
    ...server,
    current_seq: conf.seq,
    confirmed: [...server.confirmed, conf],
  };
}

/**
 * 合并轮询得到的服务端状态：同一 epoch 下游标只增不减，
 * 迟到的旧快照不得回退画面。
 *
 * 注意：跨 epoch 的新旧判定不在此处——随机 epoch 无法比较先后，
 * 由 createRefreshGate 在响应落地前完成排序（切场后旧场迟到快照
 * 会在门禁处被丢弃，根本到不了这里）。
 */
export function mergeServerState(
  prev: StateResponse,
  next: StateResponse,
): StateResponse {
  if (!prev.session || !next.session) return next;
  if (prev.session.epoch !== next.session.epoch) return next;
  if (next.session.current_seq < prev.session.current_seq) return prev;
  return next;
}

/**
 * 刷新门禁：为每次状态请求发放单调递增票据，响应返回时判定能否落地。
 *
 * 解决两类时序竞态：
 * 1) 乱序到达：较旧请求的响应晚于较新请求返回 → 拒绝落地；
 * 2) 切场竞态：导入新场（本地权威变更）后，变更前发出的请求即使
 *    迟到返回旧场快照，也必须丢弃——否则画面会退回旧场，且 reconcile
 *    会以旧 epoch 误隔离新场队列指令。
 */
export interface RefreshGate {
  /** 发起一次状态请求，返回票据。 */
  issue(): number;
  /** 本地权威变更（导入/切换场次）：使所有在途请求的票据失效。 */
  invalidate(): void;
  /** 响应返回时判定：true 表示可落地（并记录为最新已应用）。 */
  accept(ticket: number): boolean;
}

export function createRefreshGate(): RefreshGate {
  let issued = 0;
  let applied = 0;
  let invalidatedAt = 0;
  return {
    issue() {
      issued += 1;
      return issued;
    },
    invalidate() {
      invalidatedAt = issued;
    },
    accept(ticket: number) {
      if (ticket <= applied) return false; // 更晚的响应已应用（乱序到达）
      if (ticket <= invalidatedAt) return false; // 发出后发生了权威变更（迟到旧场快照）
      applied = ticket;
      return true;
    },
  };
}

/**
 * 用服务端状态校准队列：
 * - operation_id 已出现在服务端确认记录中 → 出队（幂等确认的兜底路径）；
 * - epoch 不属于活动场次 → 隔离；
 * - 其余保持待处理（包括序号被他人占用的项：它们会在推进时收到 409 并成为冲突项）。
 */
export function reconcile(
  server: SessionState | null,
  q: QueueState,
): QueueState {
  if (!server) return q;
  const isolated = [...q.isolated];
  const pending: PendingOp[] = [];
  for (const op of q.pending) {
    if (op.epoch !== server.epoch) {
      isolated.push({
        ...op,
        status: "conflict",
        note: "场次已切换，旧场指令被隔离",
      });
      continue;
    }
    if (server.confirmed.some((c) => c.operation_id === op.operation_id)) continue;
    pending.push(op);
  }
  return { pending, isolated };
}

/**
 * 处理 409 拒绝：
 * - stale_epoch / no_active_session → 移入隔离区；
 * - gap / cue_mismatch / out_of_range → 保持待处理，记录服务端期望序号。
 */
export function onRejected(
  q: QueueState,
  operationId: string,
  detail: RejectDetail,
): QueueState {
  const op = q.pending.find((o) => o.operation_id === operationId);
  if (!op) return q;
  if (detail.error === "stale_epoch" || detail.error === "no_active_session") {
    return {
      pending: q.pending.filter((o) => o.operation_id !== operationId),
      isolated: [
        ...q.isolated,
        { ...op, status: "conflict", note: detail.message },
      ],
    };
  }
  const expectedSeq =
    detail.expected_seq ??
    (detail.cursor ? detail.cursor.current_seq + 1 : undefined);
  return {
    ...q,
    pending: q.pending.map((o) =>
      o.operation_id === operationId
        ? { ...o, status: "conflict", expected_seq: expectedSeq, note: detail.message }
        : o,
    ),
  };
}
