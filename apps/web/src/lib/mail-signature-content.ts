import {
  decodeNoteContent,
  EMPTY_PLATE_NOTE_CONTENT,
  encodeNoteContent,
  type PlateElementNode,
} from "./note-content";

export type MailSignatureVariant = "full" | "short";

const SIGNATURE_MARKER = "qgw-mail-signature";

export function replaceMailSignatureContent(
  bodyContent: string,
  signature?: {
    readonly id: string;
    readonly variant: MailSignatureVariant;
    readonly text: string;
  },
): string {
  const body = decodeNoteContent(bodyContent).filter((node) => node.qgwBlockKind !== SIGNATURE_MARKER);
  if (!signature?.text.trim()) return body.length ? encodeNoteContent(body) : EMPTY_PLATE_NOTE_CONTENT;

  const signatureBlocks = signature.text.replace(/\r\n?/g, "\n").split("\n").map((line) => ({
    type: "p",
    qgwBlockKind: SIGNATURE_MARKER,
    qgwSignatureId: signature.id,
    qgwSignatureVariant: signature.variant,
    children: [{ text: line }],
  } satisfies PlateElementNode));

  return encodeNoteContent([
    ...body,
    {
      type: "p",
      qgwBlockKind: SIGNATURE_MARKER,
      qgwSignatureId: signature.id,
      qgwSignatureVariant: signature.variant,
      children: [{ text: "" }],
    },
    ...signatureBlocks,
  ]);
}

export function hasMailSignatureContent(bodyContent: string): boolean {
  return decodeNoteContent(bodyContent).some((node) => node.qgwBlockKind === SIGNATURE_MARKER);
}
