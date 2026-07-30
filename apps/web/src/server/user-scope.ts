import { getCurrentAppUser } from "./auth";

export async function getRequestUserId(): Promise<string | undefined> {
  try {
    return (await getCurrentAppUser())?.id;
  } catch {
    return undefined;
  }
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
