import crypto from "crypto";

export type UserViewKind = "transactions" | "credentials";

type UserViewTokenPayload = {
  userId: number;
  kind: UserViewKind;
  exp: number;
};

function base64UrlEncode(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function base64UrlDecode(input: string): string {
  return Buffer.from(input, "base64url").toString("utf8");
}

function signPayload(encodedPayload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

export function issueUserViewToken(params: {
  userId: number;
  kind: UserViewKind;
  secret: string;
  expiresInSeconds?: number;
}): string {
  const expiresInSeconds = params.expiresInSeconds ?? 900;
  const payload: UserViewTokenPayload = {
    userId: params.userId,
    kind: params.kind,
    exp: Math.floor(Date.now() / 1000) + Math.max(60, expiresInSeconds),
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = signPayload(encodedPayload, params.secret);
  return `${encodedPayload}.${signature}`;
}

export function verifyUserViewToken(token: string, secret: string): UserViewTokenPayload | null {
  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) return null;

  const expected = signPayload(encodedPayload, secret);
  if (signature !== expected) return null;

  try {
    const parsed = JSON.parse(base64UrlDecode(encodedPayload)) as Partial<UserViewTokenPayload>;
    if (!parsed || typeof parsed !== "object") return null;
    if (!Number.isInteger(parsed.userId) || (parsed.userId as number) <= 0) return null;
    if (parsed.kind !== "transactions" && parsed.kind !== "credentials") return null;
    if (!Number.isInteger(parsed.exp) || (parsed.exp as number) <= Math.floor(Date.now() / 1000)) return null;
    return parsed as UserViewTokenPayload;
  } catch {
    return null;
  }
}

