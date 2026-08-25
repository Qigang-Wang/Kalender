import {
  decodeNoteContent,
  noteContentToPlainText,
  type PlateNode,
} from "./note-content";

export interface CalendarDescriptionLink {
  readonly url: string;
  readonly label: "Webex" | "Teams" | "Zoom" | "Link";
  readonly meeting: boolean;
}

export function calendarDescriptionLinks(content: string): readonly CalendarDescriptionLink[] {
  const candidates: string[] = [];
  for (const node of decodeNoteContent(content)) collectNodeLinks(node, candidates);
  candidates.push(...(noteContentToPlainText(content).match(/https?:\/\/[^\s<>"']+/giu) ?? []));

  const links = new Map<string, CalendarDescriptionLink>();
  for (const candidate of candidates) {
    const normalized = normalizeCalendarDescriptionUrl(candidate);
    if (!normalized || links.has(normalized)) continue;
    links.set(normalized, classifyCalendarDescriptionLink(normalized));
  }
  return [...links.values()];
}

function collectNodeLinks(node: PlateNode, links: string[]): void {
  if ("text" in node) return;
  if (node.type === "a" && typeof node.url === "string") links.push(node.url);
  for (const child of node.children) collectNodeLinks(child, links);
}

function normalizeCalendarDescriptionUrl(value: string): string | undefined {
  const trimmed = value.trim().replace(/[),.;!?, .; !?]+$/u, "");
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function classifyCalendarDescriptionLink(url: string): CalendarDescriptionLink {
  const hostname = new URL(url).hostname.toLocaleLowerCase();
  if (hostname === "webex.com" || hostname.endsWith(".webex.com")) {
    return { url, label: "Webex", meeting: true };
  }
  if (
    hostname === "teams.microsoft.com"
    || hostname.endsWith(".teams.microsoft.com")
    || hostname === "teams.live.com"
  ) {
    return { url, label: "Teams", meeting: true };
  }
  if (hostname === "zoom.us" || hostname.endsWith(".zoom.us")) {
    return { url, label: "Zoom", meeting: true };
  }
  return { url, label: "Link", meeting: false };
}
