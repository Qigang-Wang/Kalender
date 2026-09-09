import { AsyncLocalStorage } from "node:async_hooks";
import { AuthError, getCurrentAppUser, getMcpActor } from "./auth";

const systemContext = new AsyncLocalStorage<boolean>();

/** Only trusted scheduler entry points may intentionally access all owners. */
export function runWithSystemScope<T>(operation: () => T): T {
  return systemContext.run(true, operation);
}

export async function getRequestUserId(): Promise<string | undefined> {
  if (getMcpActor()) return getMcpActor()!.id;
  if (systemContext.getStore()) return undefined;
  let user;
  try {
    user = await getCurrentAppUser();
  } catch (error) {
    // CLI/repository tests have no HTTP request. Authentication/database failures
    // inside a request must propagate; they must never remove the owner filter.
    if (error instanceof Error && (error as Error & { __NEXT_ERROR_CODE?: string }).__NEXT_ERROR_CODE === "E251") return undefined;
    throw error;
  }
  if (!user) throw new AuthError("登录已失效，请重新登录", 401);
  return user.id;
}

export async function getUserScope(): Promise<UserScope> {
  return new UserScope(await getRequestUserId());
}

export class UserScope {
  constructor(readonly userId: string | undefined) {}

  get active(): boolean {
    return Boolean(this.userId);
  }

  filter(alias: string, parameters: readonly unknown[] = []): { readonly clause: string; readonly parameters: readonly unknown[] } {
    if (!this.userId) return { clause: "", parameters };
    return {
      clause: `${alias}.user_id = $${parameters.length + 1}`,
      parameters: [...parameters, this.userId],
    };
  }

  and(alias: string, parameters: readonly unknown[] = []): { readonly clause: string; readonly parameters: readonly unknown[] } {
    const scoped = this.filter(alias, parameters);
    return scoped.clause ? { clause: ` AND ${scoped.clause}`, parameters: scoped.parameters } : scoped;
  }

  valueOrNull(): string | null {
    return this.userId ?? null;
  }
}
