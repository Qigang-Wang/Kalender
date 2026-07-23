import * as React from "react";

import { BaseBoldPlugin, BaseBlockquotePlugin, BaseItalicPlugin, BaseStrikethroughPlugin, BaseUnderlinePlugin } from "@platejs/basic-nodes";
import { BaseFontBackgroundColorPlugin, BaseFontColorPlugin } from "@platejs/basic-styles";
import { BaseLinkPlugin, getLinkAttributes } from "@platejs/link";
import { BaseListPlugin, isOrderedList } from "@platejs/list";
import juice from "juice";
import { BaseParagraphPlugin, createSlateEditor, KEYS, type RenderStaticNodeWrapper, type TLinkElement, type TListElement } from "platejs";
import { PlateStatic, SlateElement, serializeHtml, type PlateStaticProps, type SlateElementProps, type SlateRenderElementProps } from "platejs/static";
import sanitizeHtml from "sanitize-html";

import { decodeNoteContent, type PlateElementNode, type PlateNode, type PlateNoteValue } from "../lib/note-content";

const MailList: RenderStaticNodeWrapper = (props) => {
  if (!props.element.listStyleType || !isOrderedList(props.element)) return;
  return (listProps) => <MailListElement {...listProps} />;
};

const MailBaseEditorKit = [
  BaseParagraphPlugin.withComponent(MailParagraph),
  BaseBlockquotePlugin.withComponent(MailBlockquote),
  BaseLinkPlugin.withComponent(MailLink),
  BaseBoldPlugin,
  BaseItalicPlugin,
  BaseUnderlinePlugin,
  BaseStrikethroughPlugin,
  BaseFontColorPlugin.configure({ inject: { targetPlugins: [KEYS.p] } }),
  BaseFontBackgroundColorPlugin.configure({ inject: { targetPlugins: [KEYS.p] } }),
  BaseListPlugin.configure({
    inject: {
      nodeProps: {
        nodeKey: KEYS.listType,
        transformProps: ({ props }) => ({ ...props, style: { ...props.style, display: "list-item" } }),
      },
      targetPlugins: [KEYS.p, KEYS.blockquote],
    },
    render: { belowNodes: MailList },
  }),
];

export interface MailInlineImageReference {
  readonly attachmentId: string;
  readonly contentId: string;
  readonly sourceUrl: string;
}

export function mailDraftAttachmentUrl(draftId: string, attachmentId: string): string {
  return `/api/mail-drafts/${encodeURIComponent(draftId)}/attachments/${encodeURIComponent(attachmentId)}`;
}

export function mailInlineImageAttachmentIds(bodyContent: string): ReadonlySet<string> {
  const ids = new Set<string>();
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const candidate = node as { readonly type?: unknown; readonly attachmentId?: unknown; readonly children?: unknown };
    if (candidate.type === KEYS.img && typeof candidate.attachmentId === "string") ids.add(candidate.attachmentId);
    if (Array.isArray(candidate.children)) candidate.children.forEach(visit);
  };
  decodeNoteContent(bodyContent).forEach(visit);
  return ids;
}

export async function renderMailHtml(
  bodyContent: string,
  inlineImages: readonly MailInlineImageReference[] = [],
): Promise<string> {
  const inlineByAttachmentId = new Map(inlineImages.map((image) => [image.attachmentId, image]));
  const placeholders: Array<{ readonly marker: string; readonly sourceUrl: string }> = [];
  const value = replaceInlineImagesWithPlaceholders(decodeNoteContent(bodyContent), inlineByAttachmentId, placeholders);
  const editor = createSlateEditor({ plugins: MailBaseEditorKit, value });
  let editorHtml = await serializeHtml(editor, {
    editorComponent: MailStatic,
    stripClassNames: true,
    stripDataAttributes: true,
  });
  for (const placeholder of placeholders) {
    editorHtml = editorHtml.replaceAll(placeholder.marker, `<img src="${placeholder.sourceUrl}" alt=""/>`);
  }
  const inlined = juice(`<style>
    .kalender-mail-body { color: #202124; font-family: Arial, Helvetica, sans-serif; font-size: 14px; line-height: 1.6; }
    .kalender-mail-body p { margin: 0 0 9px; }
    .kalender-mail-body blockquote { margin: 9px 0; padding-left: 12px; border-left: 3px solid #c8ccd0; color: #5f6368; }
    .kalender-mail-body a { color: #1769aa; text-decoration: underline; }
    .kalender-mail-body ul, .kalender-mail-body ol { margin: 6px 0 9px; padding-left: 24px; }
    .kalender-mail-body img { display: block; max-width: 100%; height: auto; margin: 9px 0; }
  </style>${editorHtml}`, {
    applyStyleTags: true,
    removeStyleTags: true,
    preserveMediaQueries: false,
  });
  return sanitizeRenderedMailHtml(inlined, inlineImages);
}

export function sanitizeRenderedMailHtml(
  html: string,
  inlineImages: readonly MailInlineImageReference[] = [],
): string {
  const inlineContentIds = new Map(inlineImages.map((image) => [image.sourceUrl, image.contentId]));
  return sanitizeHtml(html, {
    allowedTags: ["div", "p", "br", "strong", "b", "em", "i", "u", "s", "del", "span", "a", "img", "ul", "ol", "li", "blockquote", "code", "sub", "sup"],
    allowedAttributes: {
      "*": ["style"],
      a: ["href", "target", "rel", "style"],
      img: ["src", "alt", "style"],
      ol: ["start", "style"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: { img: ["cid"] },
    allowedStyles: {
      "*": {
        color: [/^#[0-9a-f]{3,8}$/i, /^rgba?\(/i, /^[a-z]+$/i],
        "background-color": [/^#[0-9a-f]{3,8}$/i, /^rgba?\(/i, /^[a-z]+$/i],
        "font-family": [/^[\w\s,'"-]+$/],
        "font-size": [/^\d+(?:\.\d+)?(?:px|pt|em|rem|%)$/],
        "font-style": [/^(?:normal|italic)$/],
        "font-weight": [/^(?:normal|bold|[1-9]00)$/],
        "line-height": [/^\d+(?:\.\d+)?(?:px|em|rem|%)?$/],
        "list-style-type": [/^[a-z-]+$/],
        margin: [/^[\d.\s%-]+(?:px|em|rem|%)?$/],
        "margin-left": [/^\d+(?:\.\d+)?(?:px|em|rem|%)$/],
        padding: [/^[\d.\s%-]+(?:px|em|rem|%)?$/],
        "padding-left": [/^\d+(?:\.\d+)?(?:px|em|rem|%)$/],
        "text-decoration": [/^[a-z\s-]+$/],
        display: [/^(?:block|inline|inline-block)$/],
        width: [/^\d+(?:\.\d+)?(?:px|%)$/],
        "max-width": [/^\d+(?:\.\d+)?(?:px|%)$/],
        height: [/^(?:auto|\d+(?:\.\d+)?(?:px|%))$/],
      },
    },
    transformTags: {
      a: (_tagName, attributes) => ({
        tagName: "a",
        attribs: { ...attributes, rel: "noopener noreferrer", target: "_blank" },
      }),
      img: (_tagName, attributes) => {
        const contentId = attributes.src ? inlineContentIds.get(attributes.src) : undefined;
        return contentId
          ? { tagName: "img", attribs: { alt: attributes.alt ?? "", src: `cid:${contentId}`, style: attributes.style ?? "display:block;max-width:100%;height:auto;margin:9px 0" } }
          : { tagName: "span", attribs: {} as Record<string, string> };
      },
    },
  });
}

function replaceInlineImagesWithPlaceholders(
  value: PlateNoteValue,
  inlineByAttachmentId: ReadonlyMap<string, MailInlineImageReference>,
  placeholders: Array<{ readonly marker: string; readonly sourceUrl: string }>,
): PlateNoteValue {
  const visit = (node: PlateNode): PlateNode => {
    if ("text" in node) return node;
    if (node.type === KEYS.img && typeof node.attachmentId === "string") {
      const reference = inlineByAttachmentId.get(node.attachmentId);
      if (!reference) return { type: "p", children: [{ text: "" }] };
      const marker = `KALENDER_INLINE_IMAGE_${placeholders.length}_${reference.attachmentId}`;
      placeholders.push({ marker, sourceUrl: reference.sourceUrl });
      return { type: "p", children: [{ text: marker }] };
    }
    return { ...node, children: node.children.map(visit) } as PlateElementNode;
  };
  return value.map((node) => visit(node) as PlateElementNode);
}

function MailStatic(props: PlateStaticProps) {
  return <PlateStatic {...props} className="kalender-mail-body" />;
}

function MailParagraph(props: SlateElementProps) {
  return <SlateElement {...props} as="p" />;
}

function MailBlockquote(props: SlateElementProps) {
  return <SlateElement {...props} as="blockquote" />;
}

function MailLink(props: SlateElementProps<TLinkElement>) {
  return (
    <SlateElement
      {...props}
      as="a"
      attributes={{ ...props.attributes, ...getLinkAttributes(props.editor, props.element) }}
    >
      {props.children}
    </SlateElement>
  );
}

function MailListElement(props: SlateRenderElementProps) {
  const element = props.element as TListElement & { readonly indent?: number };
  const List = isOrderedList(element) ? "ol" : "ul";
  return (
    <List style={{ listStyleType: element.listStyleType, marginLeft: element.indent ? `${element.indent * 24}px` : undefined }} start={element.listStart}>
      <li>{props.children}</li>
    </List>
  );
}
