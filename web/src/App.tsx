import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, fetchState, importSession, postAdvance } from "./api";
import { newOperationId } from "./id";
import {
  applyConfirmation,
  buildOp,
  createRefreshGate,
  discardOp,
  emptyQueue,
  enqueue,
  mergeServerState,
  nextSeq,
  onRejected,
  reconcile,
  removeOp,
  type QueueState,
} from "./queue";
import type { SessionState, StateResponse } from "./types";
import { validateImport } from "./validate";

const QUEUE_KEY = "showctl.queue.v1";
const POLL_MS = 1500;

function loadQueue(): QueueState {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    if (!raw) return emptyQueue;
    const parsed = JSON.parse(raw) as QueueState;
    if (Array.isArray(parsed?.pending) && Array.isArray(parsed?.isolated)) {
      return parsed;
    }
  } catch {
    /* 忽略损坏的本地缓存 */
  }
  return emptyQueue;
}

type CueRowStatus =
  | { kind: "confirmed"; confirmedAt: string }
  | { kind: "queued" }
  | { kind: "conflict"; expectedSeq?: number; note?: string }
  | { kind: "idle" };

function cueRowStatus(session: SessionState, queue: QueueState, n: number): CueRowStatus {
  if (n <= session.current_seq) {
    const conf = session.confirmed.find((c) => c.seq === n);
    return { kind: "confirmed", confirmedAt: conf?.confirmed_at ?? "" };
  }
  const op = queue.pending.find((o) => o.epoch === session.epoch && o.seq === n);
  if (op?.status === "conflict") {
    return { kind: "conflict", expectedSeq: op.expected_seq, note: op.note };
  }
  if (op) return { kind: "queued" };
  return { kind: "idle" };
}

export default function App() {
  const [state, setState] = useState<StateResponse>({ session: null });
  const [queue, setQueue] = useState<QueueState>(loadQueue);
  const [online, setOnline] = useState<boolean>(navigator.onLine);
  const [importError, setImportError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const stateRef = useRef(state);
  stateRef.current = state;
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const flushingRef = useRef(false);
  // 刷新门禁：切场后旧场迟到的状态快照不得落地（不得回退画面、不得误隔离新场指令）。
  const gateRef = useRef(createRefreshGate());

  // 队列持久化到浏览器：断网/刷新后指令仍在。
  useEffect(() => {
    try {
      localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
    } catch {
      /* 存储不可用时静默降级 */
    }
  }, [queue]);

  const refresh = useCallback(async (): Promise<StateResponse | null> => {
    const ticket = gateRef.current.issue();
    try {
      const s = await fetchState();
      setOnline(true);
      // 迟到/失效响应（切场前的在途请求、乱序到达）直接丢弃：
      // 不落地、不参与 reconcile，画面始终停留在最新权威状态。
      if (!gateRef.current.accept(ticket)) return null;
      setState((prev) => mergeServerState(prev, s));
      setQueue((q) => reconcile(s.session, q));
      return s;
    } catch {
      setOnline(false);
      return null;
    }
  }, []);

  // 冲刷队列：按序逐条推进；409 标记冲突/隔离后继续；网络错误则判定离线。
  const flush = useCallback(async () => {
    if (!navigator.onLine || flushingRef.current) return;
    flushingRef.current = true;
    let touched = false;
    try {
      const session = stateRef.current.session;
      if (!session) return;
      const snapshot = queueRef.current.pending
        .filter((o) => o.epoch === session.epoch && o.status === "queued")
        .sort((a, b) => a.seq - b.seq);
      for (const op of snapshot) {
        const still = queueRef.current.pending.find(
          (o) => o.operation_id === op.operation_id,
        );
        if (!still || still.status !== "queued") continue;
        try {
          const conf = await postAdvance(still);
          touched = true;
          setState((prev) =>
            prev.session ? { session: applyConfirmation(prev.session, conf) } : prev,
          );
          setQueue((q) => removeOp(q, still.operation_id));
        } catch (err) {
          if (err instanceof ApiError && err.status === 409 && err.detail) {
            touched = true;
            setQueue((q) => onRejected(q, still.operation_id, err.detail!));
          } else {
            setOnline(false);
            break;
          }
        }
      }
    } finally {
      flushingRef.current = false;
      if (touched) void refresh();
    }
  }, [refresh]);

  // 初始加载 + 周期同步（在线时）。
  useEffect(() => {
    void refresh().then(() => setLoaded(true));
    const timer = setInterval(() => {
      if (!navigator.onLine) {
        setOnline(false);
        return;
      }
      void refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  // 浏览器在线/离线事件。
  useEffect(() => {
    const onOnline = () => {
      setOnline(true);
      void refresh();
    };
    const onOffline = () => setOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [refresh]);

  // 有待发送指令且在线时触发冲刷。
  const epoch = state.session?.epoch ?? null;
  const queuedCount = queue.pending.filter((o) => o.status === "queued").length;
  useEffect(() => {
    if (online && queuedCount > 0) void flush();
  }, [online, queuedCount, epoch, flush]);

  const session = state.session;
  const upcomingSeq = session ? nextSeq(session, queue) : null;
  const nextCue =
    session && upcomingSeq != null
      ? session.cues.find((c) => c.n === upcomingSeq)
      : undefined;

  const trigger = () => {
    if (!session || !nextCue) return;
    setQueue((q) => enqueue(q, buildOp(session, q, nextCue.cue_id, newOperationId)));
  };

  const onImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setImportError(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      setImportError("导入失败：文件不是合法 JSON");
      return;
    }
    const v = validateImport(parsed);
    if (!v.ok) {
      setImportError(`导入失败：${v.error}`);
      return;
    }
    try {
      const s = await importSession(v.value);
      // 导入是本地权威变更：使所有在途状态请求失效，
      // 之后到达的旧场快照一律丢弃，画面始终停留在新场。
      gateRef.current.invalidate();
      setOnline(true);
      setState(s);
      setQueue((q) => reconcile(s.session, q));
    } catch (err) {
      setImportError(
        err instanceof ApiError ? `导入失败：${err.message}` : "导入失败：网络异常",
      );
    }
  };

  return (
    <div className="app" data-testid="app" data-loaded={loaded}>
      <header className="topbar">
        <h1>穹幕演出 · 保险台</h1>
        <span
          className={`conn ${online ? "on" : "off"}`}
          data-testid="conn-status"
        >
          {online ? "● 在线" : "● 离线（指令已入队）"}
        </span>
      </header>

      <section className="panel session-panel">
        <div className="session-meta">
          {session ? (
            <>
              <span className="session-name" data-testid="session-name">
                {session.name}
              </span>
              <span className="epoch" data-testid="session-epoch">
                epoch {session.epoch.slice(0, 8)}
              </span>
              <span className="cursor" data-testid="current-seq">
                已确认 {session.current_seq} / {session.cues.length}
              </span>
            </>
          ) : (
            <span className="session-name empty" data-testid="session-name">
              尚未导入场次
            </span>
          )}
        </div>
        <label className="import-btn">
          导入场次 JSON
          <input
            type="file"
            accept="application/json,.json"
            data-testid="import-input"
            onChange={onImportFile}
          />
        </label>
      </section>

      {importError && (
        <div className="import-error" data-testid="import-error" role="alert">
          {importError}
        </div>
      )}

      {session && (
        <>
          <section className="panel trigger-panel">
            <button
              className="trigger"
              data-testid="trigger-btn"
              disabled={!nextCue}
              onClick={trigger}
            >
              {nextCue
                ? `触发 #${nextCue.n} · ${nextCue.cue_id}`
                : "全部提示已触发"}
            </button>
            {nextCue?.label && <span className="next-label">{nextCue.label}</span>}
          </section>

          <section className="panel">
            <h2>提示序列（仅已确认项计入画面）</h2>
            <ul className="cue-list" data-testid="cue-list">
              {session.cues.map((cue) => {
                const st = cueRowStatus(session, queue, cue.n);
                return (
                  <li
                    key={cue.n}
                    className={`cue-row ${st.kind}`}
                    data-testid="cue-row"
                    data-seq={cue.n}
                  >
                    <span className="cue-n">#{cue.n}</span>
                    <span className="cue-id">{cue.cue_id}</span>
                    <span className="cue-label">{cue.label ?? ""}</span>
                    <span className="cue-status" data-testid="cue-status">
                      {st.kind === "confirmed" && "✓ 已确认"}
                      {st.kind === "queued" && "… 队列中"}
                      {st.kind === "conflict" &&
                        `⚠ 冲突 · 期望序号 ${st.expectedSeq ?? "?"}`}
                      {st.kind === "idle" && "待触发"}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>

          <section className="panel">
            <h2>服务端已确认</h2>
            {session.confirmed.length === 0 ? (
              <p className="muted" data-testid="confirmed-empty">
                暂无确认记录
              </p>
            ) : (
              <ul className="confirmed-list" data-testid="confirmed-list">
                {session.confirmed.map((c) => (
                  <li key={c.seq} data-testid="confirmed-row" data-seq={c.seq}>
                    <span className="cue-n">#{c.seq}</span>
                    <span className="cue-id">{c.cue_id}</span>
                    <span className="time">{c.confirmed_at}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      <section className="panel">
        <h2>未确认队列（断网保留在浏览器）</h2>
        {queue.pending.length === 0 ? (
          <p className="muted" data-testid="pending-empty">
            队列为空
          </p>
        ) : (
          <ul className="pending-list" data-testid="pending-list">
            {queue.pending.map((op) => (
              <li
                key={op.operation_id}
                data-testid="pending-row"
                data-seq={op.seq}
                className={op.status}
              >
                <span className="cue-n">#{op.seq}</span>
                <span className="cue-id">{op.cue_id}</span>
                {op.status === "conflict" ? (
                  <span className="conflict-badge" data-testid="conflict-badge">
                    冲突 · 期望序号 {op.expected_seq ?? "?"}
                  </span>
                ) : (
                  <span className="queued-badge">待发送</span>
                )}
                {op.note && <span className="note">{op.note}</span>}
                <button
                  className="discard"
                  data-testid="discard-btn"
                  onClick={() => setQueue((q) => discardOp(q, op.operation_id))}
                >
                  丢弃
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {queue.isolated.length > 0 && (
        <section className="panel isolated-panel">
          <h2>已隔离（旧场迟到包）</h2>
          <ul className="isolated-list" data-testid="isolated-list">
            {queue.isolated.map((op) => (
              <li key={op.operation_id} data-testid="isolated-row">
                <span className="cue-n">#{op.seq}</span>
                <span className="cue-id">{op.cue_id}</span>
                <span className="note">{op.note ?? "旧场次指令，已隔离"}</span>
                <button
                  className="discard"
                  onClick={() => setQueue((q) => discardOp(q, op.operation_id))}
                >
                  清除
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
