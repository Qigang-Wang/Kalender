import { createHash, createHmac, pbkdf2 as pbkdf2Callback, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { NextResponse } from "next/server";

import { getDatabase, type DatabaseExecutor } from "./database";

const pbkdf2 = promisify(pbkdf2Callback);

export const AUTH_COOKIE_NAME = "qgw_session";
const SESSION_TTL_SECONDS = 60 * 60 * 12;
const REMEMBERED_SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const LOGIN_THROTTLE_WINDOW_MINUTES = 15;
const LOGIN_THROTTLE_MAX_FAILURES = 5;
const PASSWORD_KEY_LENGTH = 64;
const PASSWORD_ITERATIONS = 310000;
const PASSWORD_DIGEST = "sha256";
export const appUserRoles = ["admin", "user", "viewer"] as const;
export type AppUserRole = (typeof appUserRoles)[number];

export interface AppUser {
  readonly id: string;
  readonly displayName: string;
  readonly username: string;
  readonly email: string;
  readonly role: AppUserRole;
  readonly sessionVersion: number;
  readonly mustChangePassword: boolean;
}

export interface ManagedAppUser extends AppUser {
  readonly disabledAt?: string;
  readonly lastLoginAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AppInvitation {
  readonly id: string;
  readonly email: string;
  readonly displayName?: string;
  readonly role: AppUserRole;
  readonly invitedByUserId?: string;
  readonly acceptedByUserId?: string;
  readonly acceptedAt?: string;
  readonly revokedAt?: string;
  readonly expiresAt: string;
  readonly createdAt: string;
}

export interface CreatedAppInvitation extends AppInvitation {
  readonly inviteUrl: string;
  readonly token: string;
}

export interface AuthRequestContext {
  readonly ipAddress?: string;
  readonly userAgent?: string;
}

export interface AuditEvent {
  readonly id: string;
  readonly actorUserId?: string;
  readonly actorEmail?: string;
  readonly actorDisplayName?: string;
  readonly targetUserId?: string;
  readonly targetEmail?: string;
  readonly targetDisplayName?: string;
  readonly action: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly ipAddress?: string;
  readonly userAgent?: string;
  readonly createdAt: string;
}

interface AppUserRow {
  readonly id: string;
  readonly display_name: string;
  readonly email: string;
  readonly username: string;
  readonly role: AppUserRole;
  readonly session_version: number;
  readonly must_change_password: boolean;
}

interface PasswordUserRow extends AppUserRow {
  readonly password_hash: string;
  readonly disabled_at: string | null;
}

interface ManagedAppUserRow extends AppUserRow {
  readonly disabled_at: string | null;
  readonly last_login_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface AuditEventRow {
  readonly id: string;
  readonly actor_user_id: string | null;
  readonly actor_email: string | null;
  readonly actor_display_name: string | null;
  readonly target_user_id: string | null;
  readonly target_email: string | null;
  readonly target_display_name: string | null;
  readonly action: string;
  readonly metadata: Record<string, unknown>;
  readonly ip_address: string | null;
  readonly user_agent: string | null;
  readonly created_at: string;
}

interface SessionPayload {
  readonly userId: string;
  readonly username: string;
  readonly role: AppUserRole;
  readonly sessionVersion: number;
  readonly exp: number;
  readonly mustChangePassword: boolean;
  readonly iat?: number;
  readonly ttlSeconds?: number;
}

interface InvitationRow {
  readonly id: string;
  readonly email: string;
  readonly display_name: string | null;
  readonly role: AppUserRole;
  readonly invited_by_user_id: string | null;
  readonly accepted_by_user_id: string | null;
  readonly accepted_at: string | null;
  readonly revoked_at: string | null;
  readonly expires_at: string;
  readonly created_at: string;
}

export class AuthError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "AuthError";
  }
}

export async function hasAnyAppUser(database?: DatabaseExecutor): Promise<boolean> {
  const executor = database ?? await getDatabase();
  const result = await executor.query<{ exists: boolean }>("SELECT EXISTS (SELECT 1 FROM app_users) AS exists");
  return Boolean(result.rows[0]?.exists);
}

export async function createInitialAdmin(input: {
  readonly displayName: string;
  readonly username: string;
  readonly password: string;
}): Promise<AppUser> {
  const displayName = normalizeDisplayName(input.displayName);
  const username = normalizeUsername(input.username);
  const email = profileEmailForUsername(username);
  validatePassword(input.password);
  const passwordHash = await hashPassword(input.password);
  const database = await getDatabase();

  return database.transaction(async (transaction) => {
    if (await hasAnyAppUser(transaction)) {
      throw new AuthError("系统已经初始化，请使用已有账号登录", 409);
    }
    const user = {
      id: randomUUID(),
      displayName,
      username,
      email,
      role: "admin" as const,
      sessionVersion: 1,
      mustChangePassword: false,
    };
    await transaction.query(
      `INSERT INTO app_users (id, display_name, email, role)
       VALUES ($1, $2, $3, 'admin')`,
      [user.id, user.displayName, user.email],
    );
    await transaction.query(
      `INSERT INTO app_login_credentials (user_id, username, password_hash)
       VALUES ($1, $2, $3)`,
      [user.id, user.username, passwordHash],
    );
    await assignLegacyWorkspaceData(transaction, user.id);
    return user;
  });
}

export async function authenticateAppUser(
  usernameInput: string,
  password: string,
  context: AuthRequestContext = {},
): Promise<AppUser> {
  const username = normalizeUsername(usernameInput);
  if (!password) throw new AuthError("请输入密码", 400);
  const database = await getDatabase();
  await enforceLoginThrottle(database, username, context.ipAddress);
  const result = await database.query<PasswordUserRow>(
    `SELECT u.id, u.display_name, u.email, c.username, c.password_hash, u.role,
            c.session_version, u.disabled_at, c.must_change_password
       FROM app_users u
       JOIN app_login_credentials c ON c.user_id = u.id
      WHERE lower(c.username) = lower($1)
      LIMIT 1`,
    [username],
  );
  const row = result.rows[0];
  if (!row || row.disabled_at) {
    await recordLoginAttempt(database, username, false, context);
    throw new AuthError("用户名或密码不正确", 401);
  }
  if (!(await verifyPassword(password, row.password_hash))) {
    await recordLoginAttempt(database, username, false, context);
    throw new AuthError("用户名或密码不正确", 401);
  }
  await database.query(
    `UPDATE app_login_credentials SET last_login_at = now(), updated_at = now() WHERE user_id = $1`,
    [row.id],
  );
  await recordLoginAttempt(database, username, true, context);
  await recordAuditEvent({
    actorUserId: row.id,
    targetUserId: row.id,
    action: "auth.login",
    metadata: {},
    context,
  }, database);
  return rowToUser(row);
}

export async function listManagedAppUsers(actor: AppUser): Promise<readonly ManagedAppUser[]> {
  requireAdmin(actor);
  const database = await getDatabase();
  const result = await database.query<ManagedAppUserRow>(
    `SELECT u.id, u.display_name, u.email, COALESCE(c.username, '') AS username, u.role,
            COALESCE(c.session_version, 0) AS session_version, u.disabled_at, c.last_login_at,
            u.created_at, u.updated_at, COALESCE(c.must_change_password, false) AS must_change_password
       FROM app_users u
       LEFT JOIN app_login_credentials c ON c.user_id = u.id
      ORDER BY u.disabled_at NULLS FIRST, u.created_at, c.username`,
  );
  return result.rows.map(rowToManagedUser);
}

export async function listRecentAuditEvents(actor: AppUser, limit = 40): Promise<readonly AuditEvent[]> {
  requireAdmin(actor);
  const database = await getDatabase();
  const result = await database.query<AuditEventRow>(
    `SELECT e.id,
            e.actor_user_id,
            actor.email AS actor_email,
            actor.display_name AS actor_display_name,
            e.target_user_id,
            target.email AS target_email,
            target.display_name AS target_display_name,
            e.action,
            e.metadata,
            e.ip_address,
            e.user_agent,
            e.created_at
      FROM app_audit_events e
       LEFT JOIN app_users actor ON actor.id = e.actor_user_id
       LEFT JOIN app_users target ON target.id = e.target_user_id
      ORDER BY e.created_at DESC
      LIMIT $1`,
    [Math.min(100, Math.max(1, Math.round(limit)))],
  );
  return result.rows.map(rowToAuditEvent);
}

export async function listAppInvitations(actor: AppUser): Promise<readonly AppInvitation[]> {
  requireAdmin(actor);
  const database = await getDatabase();
  const result = await database.query<InvitationRow>(
    `SELECT id, email, display_name, role, invited_by_user_id, accepted_by_user_id,
            accepted_at, revoked_at, expires_at, created_at
       FROM app_invitations
      ORDER BY accepted_at NULLS FIRST, revoked_at NULLS FIRST, created_at DESC`,
  );
  return result.rows.map(rowToInvitation);
}

export async function createAppInvitation(actor: AppUser, input: {
  readonly email: string;
  readonly displayName?: string;
  readonly role?: AppUserRole;
  readonly origin: string;
}): Promise<CreatedAppInvitation> {
  requireAdmin(actor);
  const email = normalizeEmail(input.email);
  const displayName = input.displayName?.trim() ? normalizeDisplayName(input.displayName) : undefined;
  const role = normalizeRole(input.role);
  const token = randomBytes(32).toString("base64url");
  const database = await getDatabase();
  const result = await database.query<InvitationRow>(
    `INSERT INTO app_invitations (id, email, display_name, role, token_hash, invited_by_user_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + interval '7 days')
     RETURNING id, email, display_name, role, invited_by_user_id, accepted_by_user_id,
               accepted_at, revoked_at, expires_at, created_at`,
    [randomUUID(), email, displayName ?? null, role, hashInviteToken(token), actor.id],
  );
  const invitation = rowToInvitation(result.rows[0]!);
  await recordAuditEvent({
    actorUserId: actor.id,
    action: "invitation.create",
    metadata: { invitationId: invitation.id, email, role },
  }, database);
  return {
    ...invitation,
    token,
    inviteUrl: `${input.origin.replace(/\/$/, "")}/invite/${encodeURIComponent(token)}`,
  };
}

export async function revokeAppInvitation(actor: AppUser, invitationId: string): Promise<AppInvitation> {
  requireAdmin(actor);
  const database = await getDatabase();
  const result = await database.query<InvitationRow>(
    `UPDATE app_invitations
        SET revoked_at = COALESCE(revoked_at, now())
      WHERE id = $1 AND accepted_at IS NULL
      RETURNING id, email, display_name, role, invited_by_user_id, accepted_by_user_id,
                accepted_at, revoked_at, expires_at, created_at`,
    [invitationId],
  );
  const invitation = result.rows[0];
  if (!invitation) throw new AuthError("邀请不存在或已被接受", 404);
  await recordAuditEvent({
    actorUserId: actor.id,
    action: "invitation.revoke",
    metadata: { invitationId },
  }, database);
  return rowToInvitation(invitation);
}

export async function getAppInvitationByToken(token: string): Promise<AppInvitation | undefined> {
  if (!token.trim()) return undefined;
  const database = await getDatabase();
  const result = await database.query<InvitationRow>(
    `SELECT id, email, display_name, role, invited_by_user_id, accepted_by_user_id,
            accepted_at, revoked_at, expires_at, created_at
       FROM app_invitations
      WHERE token_hash = $1
      LIMIT 1`,
    [hashInviteToken(token)],
  );
  const invitation = result.rows[0];
  if (!invitation || invitation.accepted_at || invitation.revoked_at || new Date(invitation.expires_at).getTime() <= Date.now()) {
    return undefined;
  }
  return rowToInvitation(invitation);
}

export async function acceptAppInvitation(token: string, input: {
  readonly displayName: string;
  readonly username: string;
  readonly password: string;
}): Promise<AppUser> {
  const invitation = await getAppInvitationByToken(token);
  if (!invitation) throw new AuthError("邀请链接无效或已过期", 404);
  const displayName = normalizeDisplayName(input.displayName || invitation.displayName || invitation.email.split("@")[0] || "新用户");
  const username = normalizeUsername(input.username);
  validatePassword(input.password);
  const passwordHash = await hashPassword(input.password);
  const database = await getDatabase();
  return database.transaction(async (transaction) => {
    const userId = randomUUID();
    await transaction.query(
      `INSERT INTO app_users (id, display_name, email, role)
       VALUES ($1, $2, $3, $4)`,
      [userId, displayName, invitation.email, invitation.role],
    );
    await transaction.query(
      `INSERT INTO app_login_credentials (user_id, username, password_hash, must_change_password)
       VALUES ($1, $2, $3, false)`,
      [userId, username, passwordHash],
    );
    const userResult = await transaction.query<AppUserRow>(
      `SELECT u.id, u.display_name, u.email, c.username, u.role, c.session_version, c.must_change_password
         FROM app_users u JOIN app_login_credentials c ON c.user_id = u.id
        WHERE u.id = $1`,
      [userId],
    );
    const user = rowToUser(userResult.rows[0]!);
    await transaction.query(
      `UPDATE app_invitations
          SET accepted_by_user_id = $2, accepted_at = now()
        WHERE id = $1`,
      [invitation.id, user.id],
    );
    await recordAuditEvent({
      actorUserId: invitation.invitedByUserId,
      targetUserId: user.id,
      action: "invitation.accept",
      metadata: { invitationId: invitation.id, role: invitation.role },
    }, transaction);
    return user;
  }).catch((error) => {
    if (error instanceof Error && /unique|duplicate/i.test(error.message)) {
      throw new AuthError("这个用户名或邮箱已经有账号，请直接登录", 409);
    }
    throw error;
  });
}

export async function createManagedAppUser(actor: AppUser, input: {
  readonly displayName: string;
  readonly username: string;
  readonly email?: string;
  readonly password: string;
  readonly role?: AppUserRole;
  readonly mustChangePassword?: boolean;
}): Promise<ManagedAppUser> {
  requireAdmin(actor);
  const displayName = normalizeDisplayName(input.displayName);
  const username = normalizeUsername(input.username);
  const email = input.email?.trim() ? normalizeEmail(input.email) : profileEmailForUsername(username);
  validatePassword(input.password);
  const role = normalizeRole(input.role);
  const passwordHash = await hashPassword(input.password);
  const database = await getDatabase();
  try {
    const userId = randomUUID();
    await database.transaction(async (transaction) => {
      await transaction.query(
        `INSERT INTO app_users (id, display_name, email, role) VALUES ($1, $2, $3, $4)`,
        [userId, displayName, email, role],
      );
      await transaction.query(
        `INSERT INTO app_login_credentials (user_id, username, password_hash, must_change_password)
         VALUES ($1, $2, $3, $4)`,
        [userId, username, passwordHash, input.mustChangePassword ?? true],
      );
    });
    const result = await database.query<ManagedAppUserRow>(
      `SELECT u.id, u.display_name, u.email, c.username, u.role, c.session_version, c.must_change_password,
              u.disabled_at, c.last_login_at, u.created_at, u.updated_at
         FROM app_users u JOIN app_login_credentials c ON c.user_id = u.id WHERE u.id = $1`,
      [userId],
    );
    const user = rowToManagedUser(result.rows[0]!);
    await recordAuditEvent({
      actorUserId: actor.id,
      targetUserId: user.id,
      action: "user.create",
      metadata: { role: user.role },
    }, database);
    return user;
  } catch (error) {
    if (error instanceof Error && /unique|duplicate/i.test(error.message)) {
      throw new AuthError("这个用户名或邮箱已经有账号", 409);
    }
    throw error;
  }
}

export async function updateManagedAppUser(actor: AppUser, userId: string, input: {
  readonly displayName?: string;
  readonly username?: string;
  readonly email?: string;
  readonly password?: string;
  readonly role?: AppUserRole;
  readonly disabled?: boolean;
  readonly mustChangePassword?: boolean;
}): Promise<ManagedAppUser> {
  requireAdmin(actor);
  if (!userId.trim()) throw new AuthError("用户不存在", 404);
  const database = await getDatabase();
  const existing = await database.query<ManagedAppUserRow>(
      `SELECT u.id, u.display_name, u.email, COALESCE(c.username, '') AS username, u.role,
              COALESCE(c.session_version, 0) AS session_version, COALESCE(c.must_change_password, false) AS must_change_password,
              u.disabled_at, c.last_login_at, u.created_at, u.updated_at
         FROM app_users u LEFT JOIN app_login_credentials c ON c.user_id = u.id
        WHERE u.id = $1 LIMIT 1`,
    [userId],
  );
  const current = existing.rows[0];
  if (!current) throw new AuthError("用户不存在", 404);

  const nextRole = input.role ? normalizeRole(input.role) : current.role;
  const nextDisabled = input.disabled ?? Boolean(current.disabled_at);
  if (actor.id === userId && nextDisabled) throw new AuthError("不能禁用当前登录的管理员账号", 400);
  if ((current.role === "admin" && nextRole !== "admin") || (current.role === "admin" && nextDisabled && !current.disabled_at)) {
    await ensureAnotherActiveAdmin(userId);
  }

  if (input.password) validatePassword(input.password);
  const passwordHash = input.password ? await hashPassword(input.password) : undefined;
  const displayName = input.displayName === undefined ? current.display_name : normalizeDisplayName(input.displayName);
  const username = input.username === undefined ? current.username : normalizeUsername(input.username);
  const email = input.email === undefined
    ? current.email
    : input.email.trim()
      ? normalizeEmail(input.email)
      : profileEmailForUsername(username);
  try {
    await database.transaction(async (transaction) => {
      await transaction.query(
        `UPDATE app_users SET
         display_name = $2, email = $3, role = $4,
         disabled_at = CASE
           WHEN $5::boolean THEN COALESCE(disabled_at, now())
           ELSE NULL
         END,
         updated_at = now()
       WHERE id = $1`,
        [userId, displayName, email, nextRole, nextDisabled],
      );
      await transaction.query(
        `UPDATE app_login_credentials SET
           username = $2,
           password_hash = COALESCE($3, password_hash),
           session_version = CASE WHEN $3 IS NULL THEN session_version ELSE session_version + 1 END,
           must_change_password = $4,
           updated_at = now()
         WHERE user_id = $1`,
        [userId, username, passwordHash ?? null, input.mustChangePassword ?? (passwordHash ? true : current.must_change_password)],
      );
    });
    const result = await database.query<ManagedAppUserRow>(
      `SELECT u.id, u.display_name, u.email, c.username, u.role, c.session_version, c.must_change_password,
              u.disabled_at, c.last_login_at, u.created_at, u.updated_at
         FROM app_users u JOIN app_login_credentials c ON c.user_id = u.id WHERE u.id = $1`,
      [userId],
    );
    const user = rowToManagedUser(result.rows[0]!);
    await recordAuditEvent({
      actorUserId: actor.id,
      targetUserId: user.id,
      action: "user.update",
      metadata: {
        displayNameChanged: displayName !== current.display_name,
        usernameChanged: username !== current.username,
        emailChanged: email !== current.email,
        roleChanged: nextRole !== current.role,
        disabledChanged: nextDisabled !== Boolean(current.disabled_at),
        passwordReset: Boolean(passwordHash),
        mustChangePasswordChanged: (input.mustChangePassword ?? (passwordHash ? true : current.must_change_password)) !== current.must_change_password,
      },
    }, database);
    return user;
  } catch (error) {
    if (error instanceof Error && /unique|duplicate/i.test(error.message)) {
      throw new AuthError("这个用户名或邮箱已经有账号", 409);
    }
    throw error;
  }
}

export async function deleteManagedAppUser(actor: AppUser, userId: string): Promise<ManagedAppUser> {
  requireAdmin(actor);
  if (!userId.trim()) throw new AuthError("用户不存在", 404);
  if (actor.id === userId) throw new AuthError("不能删除当前登录的管理员账号", 400);

  const database = await getDatabase();
  return database.transaction(async (transaction) => {
    // User management changes are serialized so two concurrent requests cannot remove every active admin.
    await transaction.exec("LOCK TABLE app_users IN SHARE ROW EXCLUSIVE MODE");
    const existing = await transaction.query<ManagedAppUserRow>(
      `SELECT u.id, u.display_name, u.email, COALESCE(c.username, '') AS username, u.role,
              COALESCE(c.session_version, 0) AS session_version, COALESCE(c.must_change_password, false) AS must_change_password,
              u.disabled_at, c.last_login_at, u.created_at, u.updated_at
         FROM app_users u LEFT JOIN app_login_credentials c ON c.user_id = u.id
        WHERE u.id = $1
        LIMIT 1`,
      [userId],
    );
    const current = existing.rows[0];
    if (!current) throw new AuthError("用户不存在", 404);
    if (current.role === "admin" && !current.disabled_at) {
      const activeAdmins = await transaction.query<{ count: number | string }>(
        `SELECT count(*) AS count
           FROM app_users
          WHERE id <> $1 AND role = 'admin' AND disabled_at IS NULL`,
        [userId],
      );
      if (Number(activeAdmins.rows[0]?.count ?? 0) < 1) {
        throw new AuthError("至少需要保留一个可用管理员", 400);
      }
    }

    await recordAuditEvent({
      actorUserId: actor.id,
      targetUserId: current.id,
      action: "user.delete",
      metadata: {
        displayName: current.display_name,
        email: current.email,
        role: current.role,
        disabled: Boolean(current.disabled_at),
      },
    }, transaction);
    await transaction.query("DELETE FROM app_users WHERE id = $1", [userId]);
    return rowToManagedUser(current);
  });
}

export async function updateOwnProfile(actor: AppUser, input: {
  readonly displayName?: string;
  readonly currentPassword?: string;
  readonly newPassword?: string;
}): Promise<AppUser> {
  const database = await getDatabase();
  const result = await database.query<PasswordUserRow>(
    `SELECT u.id, u.display_name, u.email, c.username, c.password_hash, u.role,
            c.session_version, c.must_change_password, u.disabled_at
       FROM app_users u JOIN app_login_credentials c ON c.user_id = u.id
      WHERE u.id = $1 LIMIT 1`,
    [actor.id],
  );
  const current = result.rows[0];
  if (!current || current.disabled_at) throw new AuthError("请重新登录", 401);
  const displayName = input.displayName === undefined ? current.display_name : normalizeDisplayName(input.displayName);
  let passwordHash: string | undefined;
  if (input.newPassword) {
    if (!input.currentPassword || !await verifyPassword(input.currentPassword, current.password_hash)) {
      throw new AuthError("当前密码不正确", 401);
    }
    validatePassword(input.newPassword);
    passwordHash = await hashPassword(input.newPassword);
  }
  await database.transaction(async (transaction) => {
    await transaction.query("UPDATE app_users SET display_name = $2, updated_at = now() WHERE id = $1", [actor.id, displayName]);
    await transaction.query(
      `UPDATE app_login_credentials SET
         password_hash = COALESCE($2, password_hash),
         session_version = CASE WHEN $2 IS NULL THEN session_version ELSE session_version + 1 END,
         must_change_password = CASE WHEN $2 IS NULL THEN must_change_password ELSE false END,
         updated_at = now()
       WHERE user_id = $1`,
      [actor.id, passwordHash ?? null],
    );
  });
  const updated = await database.query<AppUserRow>(
    `SELECT u.id, u.display_name, u.email, c.username, u.role, c.session_version, c.must_change_password
       FROM app_users u JOIN app_login_credentials c ON c.user_id = u.id WHERE u.id = $1`,
    [actor.id],
  );
  const user = rowToUser(updated.rows[0]!);
  await recordAuditEvent({
    actorUserId: actor.id,
    targetUserId: actor.id,
    action: "user.profile.update",
    metadata: { displayNameChanged: displayName !== current.display_name, passwordChanged: Boolean(passwordHash) },
  }, database);
  return user;
}

export async function getCurrentAppUser(): Promise<AppUser | undefined> {
  const store = await cookies();
  const payload = verifySessionToken(store.get(AUTH_COOKIE_NAME)?.value);
  if (!payload) return undefined;
  const database = await getDatabase();
  const result = await database.query<AppUserRow & { readonly disabled_at: string | null }>(
    `SELECT u.id, u.display_name, u.email, c.username, u.role, c.session_version, c.must_change_password, u.disabled_at
       FROM app_users u
       JOIN app_login_credentials c ON c.user_id = u.id
      WHERE u.id = $1
      LIMIT 1`,
    [payload.userId],
  );
  const row = result.rows[0];
  if (!row || row.disabled_at) return undefined;
  if (row.session_version !== payload.sessionVersion) return undefined;
  return rowToUser(row);
}

export async function requireAuthenticatedAppUser(nextPath = "/today"): Promise<AppUser> {
  if (!(await hasAnyAppUser())) redirect("/setup");
  const user = await getCurrentAppUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(nextPath)}`);
  return user;
}

export function setAuthCookie(
  response: NextResponse,
  user: AppUser,
  request: Request,
  options: { readonly remember?: boolean } = {},
): void {
  const ttl = options.remember ? REMEMBERED_SESSION_TTL_SECONDS : SESSION_TTL_SECONDS;
  response.cookies.set(AUTH_COOKIE_NAME, createSessionToken(user, ttl), {
    httpOnly: true,
    sameSite: "lax",
    secure: authCookieIsSecure(request),
    path: "/",
    maxAge: ttl,
  });
}

export function clearAuthCookie(response: NextResponse, request: Request): void {
  response.cookies.set(AUTH_COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: authCookieIsSecure(request),
    path: "/",
    maxAge: 0,
  });
}

export function authCookieIsSecure(request: Request): boolean {
  const forwardedProtocol = request.headers.get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim()
    .toLocaleLowerCase();
  if (forwardedProtocol) return forwardedProtocol === "https";
  return new URL(request.url).protocol === "https:";
}

export function verifySessionToken(token: string | undefined): SessionPayload | undefined {
  if (!token) return undefined;
  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) return undefined;
  const expected = signValue(encodedPayload);
  if (!constantEqual(signature, expected)) return undefined;

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (!isSessionPayload(payload)) return undefined;
  if (payload.exp <= Math.floor(Date.now() / 1000)) return undefined;
  return payload;
}

function createSessionToken(user: AppUser, ttlSeconds: number): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = {
    userId: user.id,
    username: user.username,
    role: user.role,
    sessionVersion: user.sessionVersion,
    mustChangePassword: user.mustChangePassword,
    iat: issuedAt,
    ttlSeconds,
    exp: issuedAt + ttlSeconds,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encodedPayload}.${signValue(encodedPayload)}`;
}

function signValue(value: string): string {
  return createHmac("sha256", sessionSecret()).update(value).digest("base64url");
}

function sessionSecret(): string {
  return process.env.QGW_AUTH_SECRET
    ?? process.env.AUTH_SECRET
    ?? process.env.NEXTAUTH_SECRET
    ?? process.env.DATABASE_URL
    ?? "qgw-development-auth-secret";
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("base64url");
  const key = await pbkdf2(password, salt, PASSWORD_ITERATIONS, PASSWORD_KEY_LENGTH, PASSWORD_DIGEST) as Buffer;
  return `pbkdf2$${PASSWORD_DIGEST}$${PASSWORD_ITERATIONS}$${salt}$${key.toString("base64url")}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algorithm, digest, iterations, salt, encodedKey] = stored.split("$");
  if (algorithm !== "pbkdf2" || !digest || !iterations || !salt || !encodedKey) return false;
  const expected = Buffer.from(encodedKey, "base64url");
  const actual = await pbkdf2(password, salt, Number(iterations), expected.length, digest) as Buffer;
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AuthError("请输入有效的邮箱地址", 400);
  }
  return email;
}

function normalizeUsername(value: string): string {
  const username = value.trim().toLocaleLowerCase();
  if (username.length < 3) throw new AuthError("用户名至少需要 3 个字符", 400);
  if (username.length > 64) throw new AuthError("用户名不能超过 64 个字符", 400);
  if (!/^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u.test(username)) {
    throw new AuthError("用户名只能包含字母、数字、点、下划线和连字符", 400);
  }
  return username;
}

function profileEmailForUsername(username: string): string {
  return `${encodeURIComponent(username).replaceAll("%", "-")}@users.dayline.invalid`.toLocaleLowerCase();
}

function normalizeDisplayName(value: string): string {
  const displayName = value.trim();
  if (displayName.length < 2) throw new AuthError("昵称至少需要 2 个字符", 400);
  if (displayName.length > 80) throw new AuthError("昵称不能超过 80 个字符", 400);
  return displayName;
}

function validatePassword(password: string): void {
  if (password.length < 8) throw new AuthError("密码至少需要 8 个字符", 400);
  if (password.length > 256) throw new AuthError("密码不能超过 256 个字符", 400);
}

function normalizeRole(value: AppUserRole | undefined): AppUserRole {
  return value && appUserRoles.includes(value) ? value : "user";
}

function requireAdmin(actor: AppUser): void {
  if (actor.role !== "admin") throw new AuthError("需要管理员权限", 403);
}

async function ensureAnotherActiveAdmin(userId: string): Promise<void> {
  const database = await getDatabase();
  const result = await database.query<{ count: number | string }>(
    `SELECT count(*) AS count
       FROM app_users
      WHERE id <> $1 AND role = 'admin' AND disabled_at IS NULL`,
    [userId],
  );
  if (Number(result.rows[0]?.count ?? 0) < 1) {
    throw new AuthError("至少需要保留一个可用管理员", 400);
  }
}

function rowToUser(row: AppUserRow): AppUser {
  return {
    id: row.id,
    displayName: row.display_name,
    username: row.username,
    email: row.email.endsWith("@users.dayline.invalid") ? "" : row.email,
    role: row.role,
    sessionVersion: Number(row.session_version),
    mustChangePassword: Boolean(row.must_change_password),
  };
}

function rowToManagedUser(row: ManagedAppUserRow): ManagedAppUser {
  return {
    ...rowToUser(row),
    disabledAt: row.disabled_at ?? undefined,
    lastLoginAt: row.last_login_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToInvitation(row: InvitationRow): AppInvitation {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name ?? undefined,
    role: row.role,
    invitedByUserId: row.invited_by_user_id ?? undefined,
    acceptedByUserId: row.accepted_by_user_id ?? undefined,
    acceptedAt: row.accepted_at ?? undefined,
    revokedAt: row.revoked_at ?? undefined,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

export async function assignLegacyWorkspaceData(transaction: DatabaseExecutor, userId: string): Promise<void> {
  for (const table of [
    "accounts",
    "calendar_accounts",
    "exchange_connections",
    "calendars",
    "projects",
    "notes",
    "tasks",
    "entity_links",
    "mail_drafts",
    "mail_signatures",
    "ai_providers",
    "ai_conversations",
    "ai_feature_bindings",
  ]) {
    await transaction.query(`UPDATE ${table} SET user_id = $1 WHERE user_id IS NULL`, [userId]);
  }
}

function isSessionPayload(value: unknown): value is SessionPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<SessionPayload>;
  return typeof payload.userId === "string"
    && typeof payload.username === "string"
    && appUserRoles.includes(payload.role as AppUserRole)
    && typeof payload.sessionVersion === "number"
    && typeof payload.mustChangePassword === "boolean"
    && typeof payload.exp === "number"
    && (payload.iat === undefined || typeof payload.iat === "number")
    && (payload.ttlSeconds === undefined || typeof payload.ttlSeconds === "number");
}

function constantEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

async function enforceLoginThrottle(database: DatabaseExecutor, username: string, ipAddress?: string): Promise<void> {
  const result = await database.query<{ count: number | string }>(
    `SELECT count(*) AS count
       FROM app_login_attempts
      WHERE succeeded = false
        AND attempted_at > now() - ($1::text::interval)
        AND (lower(email) = lower($2) OR ($3::text IS NOT NULL AND ip_address = $3))`,
    [`${LOGIN_THROTTLE_WINDOW_MINUTES} minutes`, username, ipAddress ?? null],
  );
  if (Number(result.rows[0]?.count ?? 0) >= LOGIN_THROTTLE_MAX_FAILURES) {
    throw new AuthError(`登录尝试过多，请 ${LOGIN_THROTTLE_WINDOW_MINUTES} 分钟后再试`, 429);
  }
}

async function recordLoginAttempt(
  database: DatabaseExecutor,
  username: string,
  succeeded: boolean,
  context: AuthRequestContext,
): Promise<void> {
  await database.query(
    `INSERT INTO app_login_attempts (id, email, ip_address, user_agent, succeeded)
     VALUES ($1, $2, $3, $4, $5)`,
    [randomUUID(), username, context.ipAddress ?? null, context.userAgent ?? null, succeeded],
  );
}

export async function recordAuditEvent(input: {
  readonly actorUserId?: string;
  readonly targetUserId?: string;
  readonly action: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly context?: AuthRequestContext;
}, databaseInput?: DatabaseExecutor): Promise<void> {
  const database = databaseInput ?? await getDatabase();
  await database.query(
    `INSERT INTO app_audit_events (id, actor_user_id, target_user_id, action, metadata, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
    [
      randomUUID(),
      input.actorUserId ?? null,
      input.targetUserId ?? null,
      input.action,
      JSON.stringify(input.metadata),
      input.context?.ipAddress ?? null,
      input.context?.userAgent ?? null,
    ],
  );
}

function rowToAuditEvent(row: AuditEventRow): AuditEvent {
  return {
    id: row.id,
    actorUserId: row.actor_user_id ?? undefined,
    actorEmail: row.actor_email ?? undefined,
    actorDisplayName: row.actor_display_name ?? undefined,
    targetUserId: row.target_user_id ?? undefined,
    targetEmail: row.target_email ?? undefined,
    targetDisplayName: row.target_display_name ?? undefined,
    action: row.action,
    metadata: row.metadata,
    ipAddress: row.ip_address ?? undefined,
    userAgent: row.user_agent ?? undefined,
    createdAt: row.created_at,
  };
}
