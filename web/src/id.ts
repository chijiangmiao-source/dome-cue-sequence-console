/** 生成稳定 operation_id：同一指令的重试沿用同一 ID，服务端据此幂等。 */

export function newOperationId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const rand = () => Math.random().toString(16).slice(2).padEnd(12, "0");
  return `op-${Date.now().toString(16)}-${rand()}${rand()}`;
}
