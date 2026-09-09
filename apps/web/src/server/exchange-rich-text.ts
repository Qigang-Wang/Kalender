import sanitizeHtml from "sanitize-html";
import { decodeXml } from "./exchange-ews-client";
import { encodeNoteContent, type PlateElementNode, type PlateNode } from "../lib/note-content";

/** Convert supported HTML formatting into the existing calendar/mail editor format. */
export function exchangeHtmlToContent(html: string, imageUrl?: (src: string) => string | undefined): string {
  const clean = sanitizeHtml(html, {
    allowedTags: ["p", "div", "br", "b", "strong", "i", "em", "u", "s", "a", "ul", "ol", "li", "span", "img"],
    allowedAttributes: { a: ["href"], img: ["src", "alt"] },
    allowedSchemes: ["http", "https", "mailto", "cid"],
  });
  const blocks: PlateElementNode[] = [];
  let children: PlateNode[] = [];
  const tags: Array<{ name: string; href?: string }> = [];
  const flush = () => {
    if (!children.length) return;
    const list = tags.findLast((tag) => tag.name === "ul" || tag.name === "ol");
    blocks.push({ type: "p", ...(list ? { indent: tags.filter((tag) => tag.name === "ul" || tag.name === "ol").length, listStyleType: list.name === "ol" ? "decimal" : "disc" } : {}), children });
    children = [];
  };
  sanitizeHtml(clean, {
    onOpenTag(name, attrs) {
      if (name === "img") {
        const url = imageUrl?.(attrs.src ?? "");
        if (url) { flush(); blocks.push({ type: "img", url, attachmentId: url.split("/").pop(), children: [{ text: "" }] }); }
        else if (attrs.alt) children.push({ text: attrs.alt });
        return;
      }
      if (["p", "div", "li", "ul", "ol"].includes(name)) flush();
      if (name === "br") { children.push({ text: "\n" }); return; }
      tags.push({ name, href: name === "a" ? attrs.href : undefined });
    },
    onCloseTag(name) {
      if (["p", "div", "li"].includes(name)) flush();
      const index = tags.findLastIndex((tag) => tag.name === name);
      if (index >= 0) tags.splice(index);
    },
    textFilter(text) {
      const names = tags.map((tag) => tag.name);
      const leaf = { text: decodeXml(text), ...(names.some((name) => ["b", "strong"].includes(name)) ? { bold: true } : {}), ...(names.some((name) => ["i", "em"].includes(name)) ? { italic: true } : {}), ...(names.includes("u") ? { underline: true } : {}), ...(names.includes("s") ? { strikethrough: true } : {}) };
      const link = tags.findLast((tag) => tag.href);
      children.push(link ? { type: "a", url: link.href, children: [leaf] } : leaf);
      return text;
    },
  });
  flush();
  return encodeNoteContent(blocks.length ? blocks : [{ type: "p", children: [{ text: "" }] }]);
}
