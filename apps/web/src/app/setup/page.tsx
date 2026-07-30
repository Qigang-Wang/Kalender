import { redirect } from "next/navigation";
import { Suspense } from "react";

import { AuthPanel } from "@/components/auth/auth-panels";
import { getCurrentAppUser, hasAnyAppUser } from "@/server/auth";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  if (await hasAnyAppUser()) {
    redirect((await getCurrentAppUser()) ? "/today" : "/login");
  }

  return (
    <Suspense>
      <AuthPanel mode="setup" />
    </Suspense>
  );
}
