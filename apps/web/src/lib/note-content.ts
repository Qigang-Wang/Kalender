export const PLATE_NOTE_PREFIX = "plate-json-v1:";
export const EMPTY_PLATE_NOTE_CONTENT = `${PLATE_NOTE_PREFIX}[{"type":"p","children":[{"text":""}]}]`;

export interface PlateTextNode {
  text: string;
  [key: string]: unknown;
}

export interface PlateElementNode {
  type: string;
  children: PlateNode[];
  [key: string]: unknown;
}

export type PlateNode = PlateElementNode | PlateTextNode;
export type PlateNoteValue = PlateElementNode[];

export function decodeNoteContent(value: string): PlateNoteValue {
  if (value.startsWith(PLATE_NOTE_PREFIX)) {
    try {
      const parsed = JSON.parse(value.slice(PLATE_NOTE_PREFIX.length)) as unknown;
      if (isPlateNoteValue(parsed)) return parsed;
    } catch {
      return createEmptyNote();
    }
  }

  return plainTextToValue(value);
}

export function encodeNoteContent(value: PlateNoteValue): string {
  return `${PLATE_NOTE_PREFIX}${JSON.stringify(value)}`;
}

export function isTransientEditorMediaUrl(value: unknown): boolean {
  return typeof value === "string" && /^(?:blob|file):/i.test(value.trim());
}

export function noteContentToPlainText(value: string): string {
  const document = decodeNoteContent(value);

  return document
    .map(blockToPlainText)
    .join("\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function plainTextToValue(value: string): PlateNoteValue {
  const normalized = value.replace(/\r\n?/g, "\n");
  if (!normalized) return createEmptyNote();

  return normalized.split("\n").map((line) => ({
    children: [{ text: line }],
    type: "p",
  }));
}

function createEmptyNote(): PlateNoteValue {
  return [{ children: [{ text: "" }], type: "p" }];
}

function blockToPlainText(node: PlateNode): string {
  if (isTextNode(node)) return node.text;

  if (node.type === "tr") {
    return node.children.map(blockToPlainText).join("\t");
  }

  if (["table", "tbody"].includes(node.type)) {
    return node.children.map(blockToPlainText).join("\n");
  }

  return node.children.map(blockToPlainText).join("");
}

function isPlateNoteValue(value: unknown): value is PlateNoteValue {
  return Array.isArray(value) && value.length > 0 && value.every(isElementNode);
}

function isElementNode(value: unknown): value is PlateElementNode {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { readonly type?: unknown; readonly children?: unknown };
  return typeof candidate.type === "string"
    && Array.isArray(candidate.children)
    && candidate.children.every(isNode);
}

function isNode(value: unknown): value is PlateNode {
  return isTextNode(value) || isElementNode(value);
}

function isTextNode(value: unknown): value is PlateTextNode {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { readonly text?: unknown };
  return typeof candidate.text === "string";
}
