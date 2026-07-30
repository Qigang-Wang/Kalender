import {
  EMPTY_PLATE_NOTE_CONTENT,
  PLATE_NOTE_PREFIX,
  decodeNoteContent,
  encodeNoteContent,
  noteContentToPlainText,
} from "./note-content";
import { calendarDescriptionLinks } from "./calendar-description";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

const plainText = "第一段\n第二段";
const imported = decodeNoteContent(plainText);
assert(imported.length === 2, "plain-text lines become editable Plate blocks");
assert(noteContentToPlainText(plainText) === plainText, "plain text remains readable");
assert(decodeNoteContent("") !== decodeNoteContent(""), "empty notes receive independent values");
assert(noteContentToPlainText(EMPTY_PLATE_NOTE_CONTENT) === "", "empty Plate notes stay empty");

const encoded = encodeNoteContent([
  { type: "h2", children: [{ text: "会议结论" }] },
  {
    type: "p",
    indent: 1,
    listStyleType: "todo",
    checked: false,
    children: [{ text: "发送方案" }],
  },
  {
    type: "p",
    children: [
      { text: "查看" },
      { type: "a", url: "https://example.com", children: [{ text: "项目页面" }] },
    ],
  },
]);
assert(encoded.startsWith(PLATE_NOTE_PREFIX), "Plate content is versioned");
assert(
  noteContentToPlainText(encoded) === "会议结论\n发送方案\n查看项目页面",
  "Plate blocks and inline elements have a useful text projection",
);

const table = encodeNoteContent([
  {
    type: "table",
    children: [
      {
        type: "tbody",
        children: [
          {
            type: "tr",
            children: [
              { type: "td", children: [{ type: "p", children: [{ text: "事项" }] }] },
              { type: "td", children: [{ type: "p", children: [{ text: "负责人" }] }] },
            ],
          },
        ],
      },
    ],
  },
]);
assert(noteContentToPlainText(table) === "事项\t负责人", "tables remain searchable");
assert(decodeNoteContent(`${PLATE_NOTE_PREFIX}{broken`)[0]?.type === "p", "damaged JSON falls back safely");

const recognizedLinks = calendarDescriptionLinks(encodeNoteContent([
  {
    type: "p",
    children: [
      { type: "a", url: "https://rwth.webex.com/meet/example", children: [{ text: "加入会议" }] },
      { text: " https://teams.microsoft.com/l/meetup-join/example https://example.com/docs." },
    ],
  },
]));
assert(
  recognizedLinks.map((link) => link.label).join(",") === "Webex,Teams,链接",
  "calendar descriptions classify meeting and regular links",
);

console.log("Note content tests passed");
