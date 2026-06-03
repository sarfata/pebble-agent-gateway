import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function generateToken(prefix: "ri_live" | "ag_live" | "pst" | "sess"): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

export function hashToken(token: string, pepper: string): string {
  return createHash("sha256").update(`${pepper}:${token}`).digest("hex");
}

export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function hashMessage(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
