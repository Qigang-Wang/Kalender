import { AuthError, getCurrentAppUser, recordAuditEvent, type AppUser } from "./auth";
import { getDatabase, type DatabaseExecutor } from "./database";

export type ProjectAccessLevel = "viewer" | "editor";

export interface ProjectMember {
  readonly projectId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly email: string;
  readonly role: "admin" | "user" | "viewer";
  readonly accessLevel: ProjectAccessLevel;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CollaboratorUser {
  readonly id: string;
  readonly displayName: string;
  readonly email: string;
  readonly role: "admin" | "user" | "viewer";
}

interface ProjectMemberRow {
  readonly project_id: string;
  readonly user_id: string;
  readonly display_name: string;
  readonly email: string;
  readonly role: "admin" | "user" | "viewer";
  readonly access_level: ProjectAccessLevel;
  readonly created_at: string;
  readonly updated_at: string;
}

export async function listCollaboratorUsers(): Promise<readonly CollaboratorUser[]> {
  const actor = await requireUser();
  const database = await getDatabase();
  const result = await database.query<CollaboratorUser>(
    actor.role === "admin"
      ? `SELECT id, display_name AS "displayName", email, role
           FROM app_users
          WHERE disabled_at IS NULL
          ORDER BY display_name, email`
      : `SELECT id, display_name AS "displayName", email, role
           FROM app_users
          WHERE disabled_at IS NULL AND id = $1
          ORDER BY display_name, email`,
    actor.role === "admin" ? [] : [actor.id],
  );
  return result.rows;
}

export async function listProjectMembers(projectId: string): Promise<readonly ProjectMember[]> {
  const actor = await requireUser();
  await ensureProjectAccess(projectId, "viewer", actor);
  const database = await getDatabase();
  const result = await database.query<ProjectMemberRow>(
    `SELECT m.project_id, m.user_id, u.display_name, u.email, u.role,
            m.access_level, m.created_at, m.updated_at
       FROM project_members m
       JOIN app_users u ON u.id = m.user_id
      WHERE m.project_id = $1
      ORDER BY m.access_level, u.display_name, u.email`,
    [projectId],
  );
  return result.rows.map(rowToMember);
}

export async function saveProjectMembers(projectId: string, members: readonly {
  readonly userId: string;
  readonly accessLevel: ProjectAccessLevel;
}[]): Promise<readonly ProjectMember[]> {
  const actor = await requireUser();
  await ensureProjectOwner(projectId, actor);
  const database = await getDatabase();
  const normalized = members
    .filter((member) => member.userId && member.userId !== actor.id)
    .map((member) => ({
      userId: member.userId,
      accessLevel: member.accessLevel === "editor" ? "editor" as const : "viewer" as const,
    }));
  await database.transaction(async (transaction) => {
    await transaction.query("DELETE FROM project_members WHERE project_id = $1", [projectId]);
    for (const member of normalized) {
      await transaction.query(
        `INSERT INTO project_members (project_id, user_id, access_level, invited_by_user_id, updated_at)
         SELECT $1, id, $3, $4, now()
           FROM app_users
          WHERE id = $2 AND disabled_at IS NULL`,
        [projectId, member.userId, member.accessLevel, actor.id],
      );
    }
  });
  await recordAuditEvent({
    actorUserId: actor.id,
    action: "project.members.update",
    metadata: { projectId, memberCount: normalized.length },
  }, database);
  return listProjectMembers(projectId);
}

export async function ensureProjectAccess(
  projectId: string,
  minimum: ProjectAccessLevel,
  actorInput?: AppUser,
  databaseInput?: DatabaseExecutor,
): Promise<void> {
  const actor = actorInput ?? await getOptionalUser();
  if (!actor) return;
  if (actor.role === "admin") return;
  const database = databaseInput ?? await getDatabase();
  const result = await database.query<{ owner: boolean; access_level: ProjectAccessLevel | null }>(
    `SELECT p.user_id = $2 AS owner, m.access_level
       FROM projects p
       LEFT JOIN project_members m ON m.project_id = p.id AND m.user_id = $2
      WHERE p.id = $1
      LIMIT 1`,
    [projectId, actor.id],
  );
  const row = result.rows[0];
  if (!row) throw new AuthError("Projekt existiert nicht", 404);
  if (row.owner) return;
  if (row.access_level === "editor") return;
  if (minimum === "viewer" && row.access_level === "viewer") return;
  throw new AuthError("kein Zugang zum Projekt", 403);
}

export async function ensureProjectOwner(projectId: string, actorInput?: AppUser): Promise<void> {
  const actor = actorInput ?? await requireUser();
  if (actor.role === "admin") return;
  const database = await getDatabase();
  const result = await database.query<{ owner: boolean }>(
    `SELECT user_id = $2 AS owner FROM projects WHERE id = $1 LIMIT 1`,
    [projectId, actor.id],
  );
  if (!result.rows[0]) throw new AuthError("Projekt existiert nicht", 404);
  if (!result.rows[0].owner) throw new AuthError("Nur Projektinhaber können das Teilen verwalten", 403);
}

export async function visibleProjectWhere(alias: string, parameters: readonly unknown[] = []): Promise<{
  readonly clause: string;
  readonly parameters: readonly unknown[];
}> {
  const actor = await getOptionalUser();
  if (!actor) return { clause: "", parameters };
  if (actor.role === "admin") return { clause: "", parameters };
  const index = parameters.length + 1;
  return {
    clause: `(${alias}.user_id = $${index} OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = ${alias}.id AND pm.user_id = $${index}))`,
    parameters: [...parameters, actor.id],
  };
}

async function requireUser(): Promise<AppUser> {
  const actor = await getOptionalUser();
  if (!actor) throw new AuthError("Bitte melden Sie sich zuerst an", 401);
  return actor;
}

async function getOptionalUser(): Promise<AppUser | undefined> {
  try {
    return await getCurrentAppUser();
  } catch {
    return undefined;
  }
}

function rowToMember(row: ProjectMemberRow): ProjectMember {
  return {
    projectId: row.project_id,
    userId: row.user_id,
    displayName: row.display_name,
    email: row.email,
    role: row.role,
    accessLevel: row.access_level,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
