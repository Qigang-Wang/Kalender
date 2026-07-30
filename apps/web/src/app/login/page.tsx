import { redirect } from "next/navigation";
import { Suspense } from "react";

import { AuthPanel } from "@/components/auth/auth-panels";
import { getCurrentAppUser, hasAnyAppUser } from "@/server/auth";

export const dynamic = "force-dynamic";

interface LoginPageProps {
  readonly searchParams: Promise<{ readonly next?: string | readonly string[] }>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  if (!(await hasAnyAppUser())) redirect("/setup");
  const query = await searchParams;
  const nextPath = typeof query.next === "string" ? safeNextPath(query.next) : "/today";
  if (await getCurrentAppUser()) redirect(nextPath);

  return (
    <Suspense>
      <AuthPanel mode="login" />
    </Suspense>
  );
}

function safeNextPath(value: string): string {
  if (!value.startsWith("/") || value.startsWith("//")) return "/today";
  if (value.startsWith("/login") || value.startsWith("/setup")) return "/today";
  return value;
}
