/** 导入 JSON 的前端校验：结构 + 编号从 1 连续递增（与服务端规则一致）。 */

import type { Cue } from "./types";

export interface ImportPayload {
  name: string;
  cues: Cue[];
}

export type ValidateResult =
  | { ok: true; value: ImportPayload }
  | { ok: false; error: string };

export function validateImport(data: unknown): ValidateResult {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { ok: false, error: "顶层必须是对象，包含 name 与 cues 数组" };
  }
  const obj = data as Record<string, unknown>;
  if (typeof obj.name !== "string" || obj.name.trim() === "") {
    return { ok: false, error: "缺少场次名 name（非空字符串）" };
  }
  if (!Array.isArray(obj.cues) || obj.cues.length === 0) {
    return { ok: false, error: "cues 必须是非空数组" };
  }
  const cues: Cue[] = [];
  for (let i = 0; i < obj.cues.length; i += 1) {
    const raw = obj.cues[i] as Record<string, unknown> | null;
    const pos = i + 1;
    if (typeof raw !== "object" || raw === null) {
      return { ok: false, error: `第 ${pos} 条提示不是对象` };
    }
    if (typeof raw.n !== "number" || !Number.isInteger(raw.n)) {
      return { ok: false, error: `第 ${pos} 条提示缺少整数编号 n` };
    }
    if (raw.n !== pos) {
      return {
        ok: false,
        error: `提示编号必须从 1 连续递增：第 ${pos} 条提示的编号为 ${raw.n}`,
      };
    }
    if (typeof raw.cue_id !== "string" || raw.cue_id.trim() === "") {
      return { ok: false, error: `第 ${pos} 条提示缺少 cue_id（非空字符串）` };
    }
    cues.push({
      n: raw.n,
      cue_id: raw.cue_id,
      label: typeof raw.label === "string" ? raw.label : null,
    });
  }
  return { ok: true, value: { name: obj.name, cues } };
}
