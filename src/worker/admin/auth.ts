import type { MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { hmacSign, safeEqual } from '../db/crypto';
import type { Env } from '../types';

const COOKIE = 'gw_session';
const SESSION_TTL_S = 7 * 24 * 3600;

// Best-effort brute-force protection (per isolate): 10 failed logins per IP per 15 min.
const failures = new Map<string, { count: number; until: number }>();
const WINDOW_MS = 15 * 60_000;
const MAX_FAILS = 10;

export function loginBlocked(ip: string): boolean {
  const f = failures.get(ip);
  return !!f && f.count >= MAX_FAILS && f.until > Date.now();
}

export function recordLoginFailure(ip: string): void {
  const now = Date.now();
  const f = failures.get(ip);
  if (!f || f.until <= now) failures.set(ip, { count: 1, until: now + WINDOW_MS });
  else f.count++;
  if (failures.size > 5000) failures.clear();
}

export async function createSession(secret: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_S;
  return `${exp}.${await hmacSign(`session:${exp}`, secret)}`;
}

export async function verifySession(token: string | undefined, secret: string): Promise<boolean> {
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot < 1) return false;
  const exp = Number(token.slice(0, dot));
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
  return safeEqual(token.slice(dot + 1), await hmacSign(`session:${exp}`, secret));
}

export async function checkPassword(env: Env, password: string): Promise<boolean> {
  if (!env.ADMIN_PASSWORD) return false;
  return safeEqual(password, env.ADMIN_PASSWORD);
}

export function setSessionCookie(c: Parameters<MiddlewareHandler>[0], token: string): void {
  const secure = new URL(c.req.url).protocol === 'https:';
  setCookie(c, COOKIE, token, { httpOnly: true, secure, sameSite: 'Strict', path: '/api', maxAge: SESSION_TTL_S });
}

export function clearSessionCookie(c: Parameters<MiddlewareHandler>[0]): void {
  deleteCookie(c, COOKIE, { path: '/api' });
}

/**
 * Admin guard:
 * - valid signed session cookie (SameSite=Strict, so cross-site requests never carry it)
 * - mutating requests must be JSON (blocks HTML form-based CSRF)
 */
export const requireAdmin: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (!c.env.SESSION_SECRET || !c.env.ENCRYPTION_KEY || !c.env.ADMIN_PASSWORD) {
    return c.json({ error: 'Server secrets ADMIN_PASSWORD, ENCRYPTION_KEY and SESSION_SECRET must be configured.' }, 500);
  }
  if (!(await verifySession(getCookie(c, COOKIE), c.env.SESSION_SECRET))) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    const ct = c.req.header('content-type') ?? '';
    if (!ct.includes('application/json')) return c.json({ error: 'content-type must be application/json' }, 415);
  }
  await next();
};
