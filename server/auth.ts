import bcrypt from "bcrypt";
import { createHash, randomBytes } from "node:crypto";
import type { Request } from "express";
import { and, eq, gt, isNull, ne } from "drizzle-orm";
import { jwtVerify, SignJWT } from "jose";
import { sessions, type User } from "../drizzle/schema";
import { getDb, getUserByUuid } from "./db";
import { ENV } from "./_core/env";

const AUTH_TYPE = "construction-credentials";
const TOKEN_TTL = "8h";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export const AUTH_COOKIE = "northline_session";
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

type CredentialClaims = { authType: typeof AUTH_TYPE; userUuid: string };

function secretKey() {
  if (!ENV.cookieSecret || ENV.cookieSecret.length < 32)
    throw new Error("JWT_SECRET must be at least 32 characters");
  return new TextEncoder().encode(ENV.cookieSecret);
}
export async function hashPassword(password: string) {
  return bcrypt.hash(password, 12);
}
export function isAcceptablePassword(password: string) {
  return (
    typeof password === "string" &&
    password.length >= PASSWORD_MIN_LENGTH &&
    password.length <= PASSWORD_MAX_LENGTH &&
    password.trim().length >= PASSWORD_MIN_LENGTH
  );
}
export async function verifyPassword(password: string, passwordHash: string) {
  return bcrypt.compare(password, passwordHash);
}
export async function issueCredentialToken(user: User) {
  return new SignJWT({
    authType: AUTH_TYPE,
    userUuid: user.uuid,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setSubject(user.uuid)
    .setExpirationTime(TOKEN_TTL)
    .sign(secretKey());
}
function hashSessionToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}
export async function issueBrowserSession(user: User) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const token = randomBytes(32).toString("base64url");
  await db.insert(sessions).values({
    userUuid: user.uuid,
    tokenHash: hashSessionToken(token),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });
  return token;
}
export async function revokeBrowserSession(token: string) {
  const db = await getDb();
  if (!db) return;
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(sessions.tokenHash, hashSessionToken(token)),
        isNull(sessions.revokedAt),
      ),
    );
}
export async function revokeAllBrowserSessions(
  userUuid: string,
  exceptToken?: string,
) {
  const db = await getDb();
  if (!db) return;
  const conditions = [
    eq(sessions.userUuid, userUuid),
    isNull(sessions.revokedAt),
  ];
  if (exceptToken)
    conditions.push(ne(sessions.tokenHash, hashSessionToken(exceptToken)));
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(...conditions));
}
export async function listBrowserSessions(userUuid: string) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select({
      id: sessions.id,
      createdAt: sessions.createdAt,
      lastUsedAt: sessions.lastUsedAt,
      expiresAt: sessions.expiresAt,
      revokedAt: sessions.revokedAt,
    })
    .from(sessions)
    .where(
      and(
        eq(sessions.userUuid, userUuid),
        gt(sessions.expiresAt, new Date()),
        isNull(sessions.revokedAt),
      ),
    );
}
function getCookieToken(req: Request) {
  const cookieHeader = req.headers.cookie ?? "";
  const raw = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${AUTH_COOKIE}=`))
    ?.slice(AUTH_COOKIE.length + 1);
  if (!raw) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined;
  }
}
export async function authenticateCredentialRequest(
  req: Request,
): Promise<User | null> {
  const authHeader = req.headers.authorization;
  const bearerToken =
    typeof authHeader === "string" && authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : undefined;
  const cookieToken = getCookieToken(req);
  if (cookieToken && !bearerToken) {
    const db = await getDb();
    if (!db) return null;
    const rows = await db
      .select({ userUuid: sessions.userUuid })
      .from(sessions)
      .where(
        and(
          eq(sessions.tokenHash, hashSessionToken(cookieToken)),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, new Date()),
        ),
      )
      .limit(1);
    const session = rows[0];
    if (!session) return null;
    const user = await getUserByUuid(session.userUuid);
    if (user)
      await db
        .update(sessions)
        .set({ lastUsedAt: new Date() })
        .where(eq(sessions.tokenHash, hashSessionToken(cookieToken)));
    return user ?? null;
  }
  if (!bearerToken) return null;
  try {
    const { payload } = await jwtVerify(bearerToken, secretKey(), {
      algorithms: ["HS256"],
    });
    const claims = payload as Partial<CredentialClaims>;
    if (claims.authType !== AUTH_TYPE || typeof claims.userUuid !== "string")
      return null;
    return (await getUserByUuid(claims.userUuid)) ?? null;
  } catch {
    return null;
  }
}
export function getBrowserSessionToken(req: Request) {
  return getCookieToken(req);
}
export const browserSessionTtlMs = SESSION_TTL_MS;
