import { notFound } from "next/navigation";
import { WorkspaceApp, type WorkspaceSection } from "@/components/workspace-app";

const sections = ["today", "inbox", "calendar", "tasks", "notes", "ai", "settings"] as const satisfies readonly WorkspaceSection[];

interface SectionPageProps {
  readonly params: Promise<{ readonly section: string }>;
  readonly searchParams: Promise<{
    readonly message?: string | readonly string[];
    readonly task?: string | readonly string[];
    readonly schedule?: string | readonly string[];
    readonly event?: string | readonly string[];
    readonly date?: string | readonly string[];
    readonly note?: string | readonly string[];
    readonly folder?: string | readonly string[];
  }>;
}

export function generateStaticParams() {
  return sections.map((section) => ({ section }));
}

export default async function SectionPage({ params, searchParams }: SectionPageProps) {
  const { section } = await params;
  const query = await searchParams;
  if (!sections.includes(section as WorkspaceSection)) {
    notFound();
  }

  const messageId = typeof query.message === "string" ? query.message : undefined;
  const taskId = typeof query.task === "string" ? query.task : undefined;
  const scheduleTaskId = typeof query.schedule === "string" ? query.schedule : undefined;
  const eventId = typeof query.event === "string" ? query.event : undefined;
  const calendarDate = typeof query.date === "string" ? query.date : undefined;
  const noteId = typeof query.note === "string" ? query.note : undefined;
  const mailFolderId = typeof query.folder === "string" ? query.folder : undefined;
  return <WorkspaceApp section={section as WorkspaceSection} initialMessageId={messageId} initialMailFolderId={mailFolderId} initialTaskId={taskId} initialScheduleTaskId={scheduleTaskId} initialEventId={eventId} initialCalendarDate={calendarDate} initialNoteId={noteId} />;
}
