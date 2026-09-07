export type TaskNotesListKind = "ordered" | "unordered" | "task";

export function formatTaskNotesList(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  kind: TaskNotesListKind,
): { readonly value: string; readonly selectionStart: number; readonly selectionEnd: number } {
  const blockStart = value.lastIndexOf("\n", Math.max(0, selectionStart - 1)) + 1;
  const effectiveEnd = selectionEnd > selectionStart && value[selectionEnd - 1] === "\n" ? selectionEnd - 1 : selectionEnd;
  const nextNewline = value.indexOf("\n", effectiveEnd);
  const blockEnd = nextNewline === -1 ? value.length : nextNewline;
  const formatted = value.slice(blockStart, blockEnd).split("\n").map((line, index) => {
    const match = line.match(/^(\s*)(?:(?:- \[[ xX]\]|\d+\.|[-*])\s+)?/)!;
    const prefix = kind === "ordered" ? `${index + 1}. ` : kind === "task" ? "- [ ] " : "- ";
    return `${match[1]}${prefix}${line.slice(match[0].length)}`;
  }).join("\n");
  return {
    value: `${value.slice(0, blockStart)}${formatted}${value.slice(blockEnd)}`,
    selectionStart: blockStart,
    selectionEnd: blockStart + formatted.length,
  };
}
