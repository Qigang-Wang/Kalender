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
  emptyText = "还没有相关内容。",
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
        if (!response.ok || !payload.ok || !payload.related) throw new Error(payload.message ?? "无法读取相关内容");
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
    <section className={`related-content ${hideHeading ? "related-content-embedded" : ""}`} aria-label="相关内容">
      {!hideHeading && <header><span><Link2 size={14} />相关内容</span>{state === "ready" && visibleItems.length > 0 && <small>{visibleItems.length}</small>}</header>}
      {state === "loading" ? <p><LoaderCircle className="spin" size={13} />正在读取关联…</p>
        : state === "error" ? <p className="related-content-error"><AlertCircle size={13} />暂时无法读取相关内容</p>
          : visibleItems.length ? <div className="related-content-list">{visibleItems.map((item) => <Link href={item.href} key={item.linkId}>
            <RelatedEntityIcon kind={item.kind} />
            <span><strong>{item.title}</strong><small>{relationLabel(item)} · {item.meta}</small></span>
            <span>打开</span>
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
      <Link href={project.href} title={`打开项目：${project.title}`}><Folder size={12} />{project.title}</Link>
      <button aria-label={`更改所属项目：${project.title}`} title="更改所属项目" onClick={onEdit}><Pencil size={11} /></button>
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
      if (!controller.signal.aborted) setError(loadError instanceof Error ? loadError.message : "无法读取项目关联");
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
        if (!response.ok || !payload.ok) throw new Error(payload.message ?? "无法移除旧项目关联");
      }
      setProjectId(nextProjectId);
      setLinkId(nextLinkId);
      onChanged();
    } catch (changeError) {
      setError(changeError instanceof Error ? changeError.message : "无法更新项目关联");
    } finally {
      setBusy(false);
    }
  };

  return (
    <label className="project-association-control">
      <Folder size={14} />
      <span>所属项目</span>
      <AppSelect ariaLabel="所属项目" size="compact" variant="ghost" value={projectId} disabled={busy} onValueChange={(nextProjectId) => void changeProject(nextProjectId)} options={[{ value: "", label: "无项目" }, ...projects.map((project) => ({ value: project.id, label: project.name }))]} />
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
  if (item.relation === "meeting-note") return item.kind === "note" ? "会议笔记" : "对应日程";
  if (item.relation === "preparation") return item.kind === "task" ? "准备任务" : "准备事项来源";
  if (item.relation === "follow-up") return item.kind === "task" ? "跟进任务" : "跟进事项来源";
  if (item.relation === "scheduled") return item.kind === "calendar" ? "安排时间" : "对应任务";
  if (item.relation === "derived-task") return item.kind === "task" ? "生成的任务" : "任务来源";
  if (item.relation === "project-item") return item.kind === "project" ? "所属项目" : "项目内容";
  return "相关";
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
  if (!response.ok || !payload.ok || !payload.link) throw new Error(payload.message ?? "无法建立对象关联");
  return payload.link;
}
