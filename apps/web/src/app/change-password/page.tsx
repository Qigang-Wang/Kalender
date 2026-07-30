import { redirect } from "next/navigation";

import { ChangePasswordPanel } from "@/components/auth/auth-panels";
import { requireAuthenticatedAppUser } from "@/server/auth";

export const dynamic = "force-dynamic";

export default async function ChangePasswordPage() {
  const user = await requireAuthenticatedAppUser("/change-password");
  if (!user.mustChangePassword) redirect("/today");
  return <ChangePasswordPanel displayName={user.displayName} />;
}
