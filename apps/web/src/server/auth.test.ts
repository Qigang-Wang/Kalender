import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function main() {
  const testRoot = path.join(tmpdir(), `kalender-auth-test-${randomUUID()}`);
  process.env.KALENDER_DATA_DIR = testRoot;
  const auth = await import("./auth");
  const { closeDatabaseForRestore, getDatabase } = await import("./database");

  try {
    const database = await getDatabase();
    assert(!auth.authCookieIsSecure(new Request("http://workspace.example.test/login")), "HTTP login cookies are usable without TLS");
    assert(auth.authCookieIsSecure(new Request("https://workspace.example.test/login")), "HTTPS login cookies remain secure");
    assert(auth.authCookieIsSecure(new Request("http://127.0.0.1/login", {
      headers: { "x-forwarded-proto": "https" },
    })), "reverse-proxied HTTPS login cookies remain secure");
    await database.query(
      `INSERT INTO projects (id, name, color, status)
       VALUES ('legacy-project', 'Legacy', '#86bdf5', 'active')`,
    );

    const admin = await auth.createInitialAdmin({
      displayName: "Admin User",
      email: "admin@example.test",
      password: "admin-password",
    });
    assert(admin.role === "admin", "initial user is an admin");
    const loggedInAdmin = await auth.authenticateAppUser("admin@example.test", "admin-password");
    assert(loggedInAdmin.id === admin.id, "admin can authenticate");
    assert((await auth.listManagedAppUsers(admin)).find((item) => item.id === admin.id)?.lastLoginAt, "successful login records last login time");

    const legacy = await database.query<{ user_id: string | null }>("SELECT user_id FROM projects WHERE id = 'legacy-project'");
    assert(legacy.rows[0]?.user_id === admin.id, "initial admin claims legacy workspace data");

    const user = await auth.createManagedAppUser(admin, {
      displayName: "Normal User",
      email: "user@example.test",
      password: "user-password",
      role: "user",
    });
    assert(user.role === "user" && !user.disabledAt, "admin can create a normal user");
    assert((await auth.listManagedAppUsers(admin)).length === 2, "admin can list users");

    let duplicateRejected = false;
    try {
      await auth.createManagedAppUser(admin, {
        displayName: "Duplicate",
        email: "USER@example.test",
        password: "other-password",
        role: "user",
      });
    } catch (error) {
      duplicateRejected = error instanceof auth.AuthError && error.status === 409;
    }
    assert(duplicateRejected, "duplicate user emails are rejected case-insensitively");

    const disabled = await auth.updateManagedAppUser(admin, user.id, { disabled: true });
    assert(Boolean(disabled.disabledAt), "admin can disable a user");
    let disabledCannotLogin = false;
    try {
      await auth.authenticateAppUser("user@example.test", "user-password");
    } catch (error) {
      disabledCannotLogin = error instanceof auth.AuthError && error.status === 401;
    }
    assert(disabledCannotLogin, "disabled users cannot authenticate");

    const enabled = await auth.updateManagedAppUser(admin, user.id, { disabled: false, role: "admin" });
    assert(!enabled.disabledAt && enabled.role === "admin", "admin can enable and promote a user");

    const viewer = await auth.createManagedAppUser(admin, {
      displayName: "Viewer User",
      email: "viewer@example.test",
      password: "viewer-password",
      role: "viewer",
    });
    assert(viewer.role === "viewer" && viewer.mustChangePassword, "admin can create read-only users that must change initial password");

    const beforeResetVersion = enabled.sessionVersion;
    const reset = await auth.updateManagedAppUser(admin, user.id, { password: "user-password-2" });
    assert(reset.sessionVersion === beforeResetVersion + 1, "admin password reset increments session version");

    const invitation = await auth.createAppInvitation(admin, {
      displayName: "Invited User",
      email: "invited@example.test",
      role: "user",
      origin: "https://workspace.example.test",
    });
    assert(invitation.inviteUrl.includes(`/invite/${encodeURIComponent(invitation.token)}`), "admin can create invite links");
    assert((await auth.getAppInvitationByToken(invitation.token))?.email === "invited@example.test", "invite token can be resolved");
    const { buildInvitationMailContent } = await import("./invitation-mail-service");
    const { renderMailHtml } = await import("./mail-rich-text");
    const { noteContentToPlainText } = await import("../lib/note-content");
    const invitationMailContent = buildInvitationMailContent(invitation, admin);
    const invitationMailText = noteContentToPlainText(invitationMailContent);
    assert(invitationMailText.includes(invitation.inviteUrl), "invitation email includes the complete acceptance URL");
    assert(invitationMailText.includes(admin.displayName), "invitation email identifies the inviter");
    assert(invitationMailText.includes("你受邀加入 Dayline"), "invitation email has a clear plain-text heading");
    const invitationMailHtml = await renderMailHtml(invitationMailContent);
    assert(invitationMailHtml.includes("<table"), "invitation email uses a structured transactional-email layout");
    assert(invitationMailHtml.includes(">接受邀请</a>"), "invitation email includes the primary acceptance action");
    assert(invitationMailHtml.includes(`href="${invitation.inviteUrl}"`), "invitation action uses the complete acceptance URL");
    assert(invitationMailHtml.includes("Quiet Intelligence"), "invitation email includes Dayline branding");
    assert(!invitationMailHtml.includes("qgwInvitation"), "invitation template metadata is never sent to recipients");
    const invited = await auth.acceptAppInvitation(invitation.token, {
      displayName: "Invited User",
      password: "invited-password",
    });
    assert(invited.email === "invited@example.test" && !invited.mustChangePassword, "invited users can set their own password");

    let selfDisableRejected = false;
    try {
      await auth.updateManagedAppUser(admin, admin.id, { disabled: true });
    } catch (error) {
      selfDisableRejected = error instanceof auth.AuthError && error.status === 400;
    }
    assert(selfDisableRejected, "admin cannot disable the current account");

    const disposable = await auth.createManagedAppUser(admin, {
      displayName: "Disposable User",
      email: "disposable@example.test",
      password: "disposable-password",
      role: "user",
    });
    await database.query(
      `INSERT INTO projects (id, name, color, status, user_id)
       VALUES ('disposable-project', 'Disposable Project', '#86bdf5', 'active', $1)`,
      [disposable.id],
    );
    const deleted = await auth.deleteManagedAppUser(admin, disposable.id);
    assert(deleted.id === disposable.id, "admin can permanently delete another user");
    assert(!(await auth.listManagedAppUsers(admin)).some((item) => item.id === disposable.id), "deleted user is removed from user management");
    const deletedProjects = await database.query<{ count: number | string }>("SELECT count(*) AS count FROM projects WHERE id = 'disposable-project'");
    assert(Number(deletedProjects.rows[0]?.count ?? 0) === 0, "deleting a user cascades to owned workspace data");
    let deletedCannotLogin = false;
    try {
      await auth.authenticateAppUser("disposable@example.test", "disposable-password");
    } catch (error) {
      deletedCannotLogin = error instanceof auth.AuthError && error.status === 401;
    }
    assert(deletedCannotLogin, "deleted users cannot authenticate");

    let selfDeleteRejected = false;
    try {
      await auth.deleteManagedAppUser(admin, admin.id);
    } catch (error) {
      selfDeleteRejected = error instanceof auth.AuthError && error.status === 400;
    }
    assert(selfDeleteRejected, "admin cannot delete the current account");

    const updatedProfile = await auth.updateOwnProfile(admin, {
      displayName: "Renamed Admin",
      currentPassword: "admin-password",
      newPassword: "admin-password-2",
    });
    assert(updatedProfile.displayName === "Renamed Admin", "user can update own display name");
    assert(updatedProfile.sessionVersion === admin.sessionVersion + 1, "own password change increments session version");
    assert((await auth.authenticateAppUser("admin@example.test", "admin-password-2")).id === admin.id, "user can update own password");

    let throttled = false;
    for (let index = 0; index < 6; index += 1) {
      try {
        await auth.authenticateAppUser("missing@example.test", "wrong-password", { ipAddress: "203.0.113.9" });
      } catch (error) {
        throttled ||= error instanceof auth.AuthError && error.status === 429;
      }
    }
    assert(throttled, "repeated failed logins are rate limited");

    const auditEvents = await auth.listRecentAuditEvents(updatedProfile, 10);
    assert(auditEvents.some((event) => event.action === "auth.login"), "login audit events are recorded");

    console.log("Auth and user management tests passed");
    await closeDatabaseForRestore();
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
