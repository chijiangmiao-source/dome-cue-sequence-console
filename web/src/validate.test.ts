import { describe, expect, it } from "vitest";
import { validateImport } from "./validate";

describe("validateImport：导入 JSON 校验", () => {
  it("合法载荷通过", () => {
    const r = validateImport({
      name: "第一场",
      cues: [
        { n: 1, cue_id: "a", label: "灯光" },
        { n: 2, cue_id: "b" },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.name).toBe("第一场");
      expect(r.value.cues).toHaveLength(2);
    }
  });

  it("编号跳号被拒绝", () => {
    const r = validateImport({
      name: "x",
      cues: [
        { n: 1, cue_id: "a" },
        { n: 3, cue_id: "b" },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("连续递增");
  });

  it("编号不从 1 开始被拒绝", () => {
    const r = validateImport({ name: "x", cues: [{ n: 2, cue_id: "a" }] });
    expect(r.ok).toBe(false);
  });

  it("缺少 cue_id 被拒绝", () => {
    const r = validateImport({ name: "x", cues: [{ n: 1 }] });
    expect(r.ok).toBe(false);
  });

  it("空提示数组被拒绝", () => {
    expect(validateImport({ name: "x", cues: [] }).ok).toBe(false);
  });

  it("缺少场次名被拒绝", () => {
    expect(validateImport({ cues: [{ n: 1, cue_id: "a" }] }).ok).toBe(false);
  });

  it("非对象载荷被拒绝", () => {
    expect(validateImport([1, 2, 3]).ok).toBe(false);
    expect(validateImport("str").ok).toBe(false);
    expect(validateImport(null).ok).toBe(false);
  });
});
