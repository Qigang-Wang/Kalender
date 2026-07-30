import { notFound } from "next/navigation";
import { WorkspaceApp, type TaskView, type WorkspaceSection } from "@/components/workspace-app";
import { requireAuthenticatedAppUser } from "@/server/auth";

const sections = ["today", "inbox", "calendar", "tasks", "projects", "notes", "ai", "settings"] as const satisfies readonly WorkspaceSection[];
const taskViews = ["today", "inbox", "upcoming", "waiting", "projects", "completed", "matrix"] as const satisfies readonly TaskView[];

interface SectionPageProps {
  readonly params: Promise<{ readonly section: string }>;
  readonly searchParams: Promise<{
    readonly message?: string | readonly string[];
    readonly task?: string | readonly string[];
    readonly view?: string | readonly string[];
    readonly create?: string | readonly string[];
    readonly schedule?: string | readonly string[];
    readonly event?: string | readonly string[];
    readonly date?: string | readonly string[];
    readonly note?: string | readonly string[];
    readonly filter?: string | readonly string[];
    readonly project?: string | readonly string[];
    readonly folder?: string | readonly string[];
    readonly correspondent?: string | readonly string[];
    readonly compose?: string | readonly string[];
    readonly to?: string | readonly string[];
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
  const nextPath = `/${section}${toQueryString(query)}`;
  const currentUser = await requireAuthenticatedAppUser(nextPath);

  const messageId = typeof query.message === "string" ? query.message : undefined;
  const taskId = typeof query.task === "string" ? query.task : undefined;
  const taskView = typeof query.view === "string" && taskViews.includes(query.view as TaskView) ? query.view as TaskView : undefined;
  const createTask = query.create === "true";
  const scheduleTaskId = typeof query.schedule === "string" ? query.schedule : undefined;
  const eventId = typeof query.event === "string" ? query.event : undefined;
  const calendarDate = typeof query.date === "string" ? query.date : undefined;
  const noteId = typeof query.note === "string" ? query.note : undefined;
  const noteFilter = query.filter === "pinned" || query.filter === "unfiled" ? query.filter : undefined;
  const projectId = typeof query.project === "string" ? query.project : undefined;
  const mailFolderId = typeof query.folder === "string" ? query.folder : undefined;
  const mailCorrespondent = typeof query.correspondent === "string" ? query.correspondent : undefined;
  const initialComposeTo = query.compose === "true" && typeof query.to === "string" ? query.to : undefined;
  return <WorkspaceApp section={section as WorkspaceSection} currentUser={currentUser} initialMessageId={messageId} initialMailFolderId={mailFolderId} initialMailCorrespondent={mailCorrespondent} initialComposeTo={initialComposeTo} initialTaskId={taskId} initialTaskView={taskView} initialCreateTask={createTask} initialScheduleTaskId={scheduleTaskId} initialEventId={eventId} initialCalendarDate={calendarDate} initialNoteId={noteId} initialNoteFilter={noteFilter} initialProjectId={projectId} />;
}

function toQueryString(query: SectionPageProps["searchParams"] extends Promise<infer T> ? T : never): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === "string") params.set(key, value);
  }
  const serialized = params.toString();
  return serialized ? `?${serialized}` : "";
}
