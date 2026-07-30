import { redirect } from "next/navigation";

import { hasAnyAppUser } from "@/server/auth";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  redirect((await hasAnyAppUser()) ? "/today" : "/setup");
}
