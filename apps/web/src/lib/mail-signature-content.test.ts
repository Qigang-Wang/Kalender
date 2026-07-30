import assert from "node:assert/strict";

import { decodeNoteContent, encodeNoteContent, noteContentToPlainText } from "./note-content";
import { hasMailSignatureContent, replaceMailSignatureContent } from "./mail-signature-content";

const original = encodeNoteContent([{ type: "p", children: [{ text: "正文", bold: true }] }]);
const full = replaceMailSignatureContent(original, {
  id: "work",
  variant: "full",
  text: "此致\n王其刚",
});

assert.equal(noteContentToPlainText(full), "正文\n\n此致\n王其刚");
assert.equal(hasMailSignatureContent(full), true);
assert.equal(decodeNoteContent(full)[0]?.children[0]?.bold, true);

const short = replaceMailSignatureContent(full, {
  id: "work",
  variant: "short",
  text: "王其刚",
});
assert.equal(noteContentToPlainText(short), "正文\n\n王其刚");
assert.equal(decodeNoteContent(short).filter((node) => node.qgwBlockKind === "qgw-mail-signature").length, 2);

const removed = replaceMailSignatureContent(short);
assert.equal(noteContentToPlainText(removed), "正文");
assert.equal(hasMailSignatureContent(removed), false);

console.log("Mail signature content tests passed");
