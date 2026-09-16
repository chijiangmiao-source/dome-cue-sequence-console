/** API 封装：同源 /api 前缀（开发由 Vite 代理、生产由 nginx 反代）。 */

import type { AdvanceOk, RejectDetail, StateResponse } from "./types";
import type { PendingOp } from "./queue";
import type { ImportPayload } from "./validate";

export class ApiError extends Error {
  constructor(
    public status: number,
    public detail: RejectDetail | null,
  ) {
    super(detail?.message ?? `HTTP ${status}`);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, (body?.detail ?? null) as RejectDetail | null);
  }
  return body as T;
}

export function fetchState(): Promise<StateResponse> {
  return request<StateResponse>("/api/state");
}

export function importSession(payload: ImportPayload): Promise<StateResponse> {
  return request<StateResponse>("/api/sessions/import", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function postAdvance(op: PendingOp): Promise<AdvanceOk> {
  return request<AdvanceOk>("/api/advance", {
    method: "POST",
    body: JSON.stringify({
      operation_id: op.operation_id,
      epoch: op.epoch,
      seq: op.seq,
      cue_id: op.cue_id,
    }),
  });
}
