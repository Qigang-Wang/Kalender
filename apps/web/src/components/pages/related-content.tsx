"use client";

import Link from "next/link";
import { AlertCircle, CalendarDays, Folder, FolderPlus, Link2, ListChecks, LoaderCircle, Mail, NotebookPen, Pencil } from "lucide-react";
import { useEffect, useState } from "react";

import { AppSelect } from "../app-select";

interface ClientProject {
  readonly id: string;
  readonly name: string;
}

type RelatedEntityKind = "mail" | "calendar" | "task" | "note" | "project";

interface RelatedEntityItem {
  readonly linkId: string;
  readonly kind: RelatedEntityKind;
  readonly entityId: string;
  readonly title: string;
  readonly meta: string;
  readonly href: string;
  readonly relation: string;
  readonly direction: "source" | "target";
}

export function RelatedContentPanel({
  kind,
  entityId,
  refreshKey = 0,
  hideHeading = false,
  hideWhenEmpty = false,
  emptyText = "Es stehen keine relevanten Inhalte zur Verfügung.",
  excludeRelations = [],
}: {
  readonly kind: RelatedEntityKind;
  readonly entityId: string;
  readonly refreshKey?: number;
  readonly hideHeading?: boolean;
  readonly hideWhenEmpty?: boolean;
  readonly emptyText?: string;
  readonly excludeRelations?: readonly string[];
}) {
  const [items, setItems] = useState<readonly RelatedEntityItem[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    const controller = new AbortController();
    setState("loading");
    void fetch(`/api/entity-links?kind=${encodeURIComponent(kind)}&id=${encodeURIComponent(entityId)}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as { readonly ok?: boolean; readonly related?: readonly RelatedEntityItem[]; readonly message?: string };
        if (!response.ok || !payload.ok || !payload.related) throw new Error(payload.message ?? "relevante Inhalte nicht lesen");
        setItems(payload.related);
        setState("ready");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState("error");
        console.error("Related content loading failed", error);
      });
    return () => controller.abort();
  }, [entityId, kind, refreshKey]);

  const visibleItems = items.filter((item) => !excludeRelations.includes(item.relation));

  if (hideWhenEmpty && (state === "loading" || (state === "ready" && visibleItems.length === 0))) return null;

  return (
    <section className={`related-content ${hideHeading ? "related-content-embedded" : ""}`} aria-label="sachdienlich">
      {!hideHeading && <header><span><Link2 size={14} />sachdienlich</span>{state === "ready" && visibleItems.length > 0 && <small>{visibleItems.length}</small>}</header>}
      {state === "loading" ? <p><LoaderCircle className="spin" size={13} />Leseassoziation...</p>
        : state === "error" ? <p className="related-content-error"><AlertCircle size={13} />relevante Inhalte können vorerst nicht gelesen werden</p>
          : visibleItems.length ? <div className="related-content-list">{visibleItems.map((item) => <Link href={item.href} key={item.linkId}>
            <RelatedEntityIcon kind={item.kind} />
            <span><strong>{item.title}</strong><small>{relationLabel(item)} · {item.meta}</small></span>
            <span>geöffnet</span>
          </Link>)}</div>
            : <p>{emptyText}</p>}
    </section>
  );
}

export function MailProjectChip({
  entityId,
  refreshKey,
  onEdit,
}: {
  readonly entityId: string;
  readonly refreshKey: number;
  readonly onEdit: () => void;
}) {
  const [project, setProject] = useState<RelatedEntityItem>();

  useEffect(() => {
    const controller = new AbortController();
    setProject(undefined);
    void fetch(`/api/entity-links?kind=mail&id=${encodeURIComponent(entityId)}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as { readonly ok?: boolean; readonly related?: readonly RelatedEntityItem[] };
        if (!response.ok || !payload.ok) return;
        setProject(payload.related?.find((item) => item.kind === "project" && item.relation === "project-item"));
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [entityId, refreshKey]);

  if (!project) return null;
  return (
    <span className="mail-project-chip">
      <Link href={project.href} title={`Offenes Projekt:${project.title}`}><Folder size={12} />{project.title}</Link>
      <button aria-label={`Projekt(e) ändern:${project.title}`} title="Projekte ändern" onClick={onEdit}><Pencil size={11} /></button>
    </span>
  );
}

export function ProjectAssociationControl({
  kind,
  entityId,
  onChanged,
}: {
  readonly kind: "mail" | "calendar";
  readonly entityId: string;
  readonly onChanged: () => void;
}) {
  const [projects, setProjects] = useState<readonly ClientProject[]>([]);
  const [projectId, setProjectId] = useState("");
  const [linkId, setLinkId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      fetch("/api/projects", { cache: "no-store", signal: controller.signal }).then((response) => response.json()) as Promise<{ readonly projects?: readonly ClientProject[] }>,
      fetch(`/api/entity-links?kind=${encodeURIComponent(kind)}&id=${encodeURIComponent(entityId)}`, { cache: "no-store", signal: controller.signal }).then((response) => response.json()) as Promise<{ readonly related?: readonly RelatedEntityItem[] }>,
    ]).then(([projectPayload, linkPayload]) => {
      setProjects(projectPayload.projects ?? []);
      const current = linkPayload.related?.find((item) => item.kind === "project" && item.relation === "project-item");
      setProjectId(current?.entityId ?? "");
      setLinkId(current?.linkId);
    }).catch((loadError: unknown) => {
      if (!controller.signal.aborted) setError(loadError instanceof Error ? loadError.message : "Projekt-Assoziation kann nicht gelesen werden");
    });
    return () => controller.abort();
  }, [entityId, kind]);

  const changeProject = async (nextProjectId: string) => {
    if (busy || nextProjectId === projectId) return;
    setBusy(true);
    setError(undefined);
    try {
      let nextLinkId: string | undefined;
      if (nextProjectId) {
        const link = await createClientEntityLink({
          sourceKind: "project",
          sourceId: nextProjectId,
          targetKind: kind,
          targetId: entityId,
          relation: "project-item",
        });
        nextLinkId = link.id;
      }
      if (linkId && linkId !== nextLinkId) {
        const response = await fetch(`/api/entity-links/${encodeURIComponent(linkId)}`, { method: "DELETE" });
        const payload = await response.json() as { readonly ok?: boolean; readonly message?: string };
        if (!response.ok || !payload.ok) throw new Error(payload.message ?? "Die alte Projektverbindung kann nicht entfernt werden");
      }
      setProjectId(nextProjectId);
      setLinkId(nextLinkId);
      onChanged();
    } catch (changeError) {
      setError(changeError instanceof Error ? changeError.message : "Projektverbindung kann nicht aktualisiert werden");
    } finally {
      setBusy(false);
    }
  };

  return (
    <label className="project-association-control">
      <Folder size={14} />
      <span>Gegenstände, die zu</span>
      <AppSelect ariaLabel="Projekte, die zu" size="compact" variant="ghost" value={projectId} disabled={busy} onValueChange={(nextProjectId) => void changeProject(nextProjectId)} options={[{ value: "", label: "keine Projekte" }, ...projects.map((project) => ({ value: project.id, label: project.name }))]} />
      {busy && <LoaderCircle className="spin" size={13} />}
      {error && <small>{error}</small>}
    </label>
  );
}

function RelatedEntityIcon({ kind }: { readonly kind: RelatedEntityKind }) {
  const Icon = kind === "mail" ? Mail
    : kind === "calendar" ? CalendarDays
      : kind === "task" ? ListChecks
        : kind === "note" ? NotebookPen
          : FolderPlus;
  return <Icon size={15} />;
}

function relationLabel(item: RelatedEntityItem): string {
  if (item.relation === "meeting-note") return item.kind === "note" ? "Besprechungsnotiz" : "Zugehöriger Termin";
  if (item.relation === "preparation") return item.kind === "task" ? "Vorbereitung der Aufgaben" : "Zubereitungsquelle";
  if (item.relation === "follow-up") return item.kind === "task" ? "Folgeaufgaben" : "Folgequelle";
  if (item.relation === "scheduled") return item.kind === "calendar" ? "Zeitplanung" : "entsprechende Aufgaben";
  if (item.relation === "derived-task") return item.kind === "task" ? "Erzeugte Aufgaben" : "Aufgabenquelle";
  if (item.relation === "project-item") return item.kind === "project" ? "Projekte, die zu" : "Projektinhalt";
  return "sachdienlich";
}

export async function createClientEntityLink(input: {
  readonly sourceKind: RelatedEntityKind;
  readonly sourceId: string;
  readonly targetKind: RelatedEntityKind;
  readonly targetId: string;
  readonly relation: string;
}): Promise<{ readonly id: string }> {
  const response = await fetch("/api/entity-links", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const payload = await response.json() as { readonly ok?: boolean; readonly link?: { readonly id: string }; readonly message?: string };
  if (!response.ok || !payload.ok || !payload.link) throw new Error(payload.message ?? "Objektverbindung kann nicht erstellt werden");
  return payload.link;
}
