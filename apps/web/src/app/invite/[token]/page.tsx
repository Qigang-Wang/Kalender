import { notFound, redirect } from "next/navigation";

import { InviteAcceptPanel } from "@/components/auth/auth-panels";
import { getAppInvitationByToken, getCurrentAppUser } from "@/server/auth";

export const dynamic = "force-dynamic";

interface InvitePageProps {
  readonly params: Promise<{ readonly token: string }>;
}

export default async function InvitePage({ params }: InvitePageProps) {
  if (await getCurrentAppUser()) redirect("/today");
  const { token } = await params;
  const invitation = await getAppInvitationByToken(token);
  if (!invitation) notFound();
  return (
    <InviteAcceptPanel
      token={token}
      email={invitation.email}
      suggestedName={invitation.displayName ?? invitation.email.split("@")[0] ?? ""}
    />
  );
}
