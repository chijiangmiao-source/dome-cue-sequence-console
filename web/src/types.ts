/** 与服务端 API 对齐的类型定义。 */

export interface Cue {
  n: number;
  cue_id: string;
  label?: string | null;
}

export interface Confirmation {
  session_id: string;
  epoch: string;
  seq: number;
  cue_id: string;
  operation_id: string;
  confirmed_at: string;
}

export interface SessionState {
  session_id: string;
  name: string;
  epoch: string;
  status?: string;
  current_seq: number;
  cues: Cue[];
  confirmed: Confirmation[];
}

export interface StateResponse {
  session: SessionState | null;
}

export interface Cursor {
  session_id: string;
  epoch: string;
  current_seq: number;
}

/** 409 拒绝时服务端返回的 detail 结构。 */
export interface RejectDetail {
  error:
    | "stale_epoch"
    | "gap"
    | "cue_mismatch"
    | "out_of_range"
    | "no_active_session"
    | string;
  message: string;
  cursor: Cursor | null;
  expected_seq?: number;
  expected_cue_id?: string;
}

export interface AdvanceOk extends Confirmation {
  status: "confirmed";
  duplicate: boolean;
  current_seq: number;
}
