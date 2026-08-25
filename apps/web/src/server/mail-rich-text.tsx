import * as React from "react";

import { BaseBoldPlugin, BaseBlockquotePlugin, BaseItalicPlugin, BaseStrikethroughPlugin, BaseUnderlinePlugin } from "@platejs/basic-nodes";
import { BaseFontBackgroundColorPlugin, BaseFontColorPlugin } from "@platejs/basic-styles";
import { BaseLinkPlugin, getLinkAttributes } from "@platejs/link";
import { BaseListPlugin, isOrderedList } from "@platejs/list";
import juice from "juice";
import { BaseParagraphPlugin, createSlateEditor, KEYS, type RenderStaticNodeWrapper, type TLinkElement, type TListElement } from "platejs";
import { PlateStatic, SlateElement, serializeHtml, type PlateStaticProps, type SlateElementProps, type SlateRenderElementProps } from "platejs/static";
import sanitizeHtml from "sanitize-html";

import {
  isDaylineInvitationBlock,
  readDaylineInvitationTemplate,
  type DaylineInvitationTemplateData,
} from "../lib/mail-invitation-content";
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
  const decoded = decodeNoteContent(bodyContent);
  const invitation = readDaylineInvitationTemplate(decoded);
  const contentValue = invitation ? decoded.filter((node) => !isDaylineInvitationBlock(node)) : decoded;
  const value = replaceInlineImagesWithPlaceholders(contentValue, inlineByAttachmentId, placeholders);
  let editorHtml = "";
  if (value.length > 0) {
    const editor = createSlateEditor({ plugins: MailBaseEditorKit, value });
    editorHtml = await serializeHtml(editor, {
      editorComponent: MailStatic,
      stripClassNames: true,
      stripDataAttributes: true,
    });
  }
  for (const placeholder of placeholders) {
    editorHtml = editorHtml.replaceAll(placeholder.marker, `<img src="${placeholder.sourceUrl}" alt=""/>`);
  }
  if (invitation) editorHtml = renderDaylineInvitationHtml(invitation, editorHtml);
  const inlined = juice(`<style>
    .kalender-mail-body { color: #202124; font-family: Arial, Helvetica, sans-serif; font-size: 14px; line-height: 1.6; }
    .kalender-mail-body p { margin: 0 0 9px; }
    .kalender-mail-body blockquote { margin: 9px 0; padding-left: 12px; border-left: 3px solid #c8ccd0; color: #5f6368; }
    .kalender-mail-body a { color: #1769aa; text-decoration: underline; }
    .kalender-mail-body ul, .kalender-mail-body ol { margin: 6px 0 9px; padding-left: 24px; }
    .kalender-mail-body img { display: block; max-width: 100%; height: auto; margin: 9px 0; }
    .dayline-invitation-email { width: 100%; background-color: #f4f7fa; color: #20262e; font-family: Arial, Helvetica, sans-serif; }
    .dayline-invitation-frame { width: 100%; max-width: 640px; background-color: #ffffff; border: 1px solid #dce4ec; border-collapse: separate; border-spacing: 0; }
    .dayline-invitation-header { padding: 24px 32px; border-bottom: 1px solid #e3e9ef; }
    .dayline-invitation-logo { width: 42px; height: 42px; background-color: #5f91d3; border-radius: 7px; color: #ffffff; font-size: 26px; font-weight: bold; line-height: 42px; text-align: center; }
    .dayline-invitation-brand { padding-left: 12px; }
    .dayline-invitation-brand-name { color: #20262e; font-size: 20px; font-weight: 700; line-height: 24px; }
    .dayline-invitation-brand-tagline { color: #697684; font-size: 12px; line-height: 18px; }
    .dayline-invitation-content { padding: 34px 32px 30px; }
    .dayline-invitation-title { margin: 0 0 24px; color: #20262e; font-size: 26px; font-weight: 700; line-height: 34px; }
    .dayline-invitation-greeting { margin: 0 0 12px; color: #20262e; font-size: 16px; font-weight: 600; line-height: 24px; }
    .dayline-invitation-copy { margin: 0 0 22px; color: #3e4955; font-size: 14px; line-height: 23px; }
    .dayline-invitation-details { width: 100%; background-color: #f7faff; border: 1px solid #cfdeef; border-collapse: separate; border-spacing: 0; }
    .dayline-invitation-detail { width: 33%; padding: 15px 14px; vertical-align: top; }
    .dayline-invitation-detail-border { border-left: 1px solid #dce6f1; }
    .dayline-invitation-label { color: #697684; font-size: 12px; line-height: 18px; }
    .dayline-invitation-value { color: #20262e; font-size: 14px; font-weight: 700; line-height: 21px; overflow-wrap: anywhere; }
    .dayline-invitation-action { padding: 26px 0 22px; }
    .dayline-invitation-button-cell { background-color: #5f91d3; border-radius: 6px; text-align: center; }
    .dayline-invitation-button { display: block; padding: 12px 26px; color: #ffffff; font-size: 15px; font-weight: 700; line-height: 20px; text-decoration: none; }
    .dayline-invitation-help { margin: 0 0 5px; color: #697684; font-size: 12px; line-height: 19px; }
    .dayline-invitation-url { color: #356fae; font-size: 12px; line-height: 19px; text-decoration: underline; overflow-wrap: anywhere; word-break: break-all; }
    .dayline-invitation-security { margin: 22px 0 0; color: #697684; font-size: 12px; line-height: 19px; }
    .dayline-invitation-signature { padding-top: 20px; border-top: 1px solid #e3e9ef; }
    .dayline-invitation-signature .kalender-mail-body { color: #3e4955; font-size: 13px; line-height: 1.5; }
    .dayline-invitation-footer { padding: 16px 32px; border-top: 1px solid #e3e9ef; color: #697684; font-size: 12px; line-height: 18px; text-align: center; }
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
    allowedTags: ["div", "p", "br", "strong", "b", "em", "i", "u", "s", "del", "span", "a", "img", "ul", "ol", "li", "blockquote", "code", "sub", "sup", "table", "tbody", "tr", "td"],
    allowedAttributes: {
      "*": ["style"],
      a: ["href", "target", "rel", "style"],
      img: ["src", "alt", "style"],
      ol: ["start", "style"],
      table: ["role", "width", "cellpadding", "cellspacing", "border", "align", "style"],
      td: ["width", "align", "valign", "style"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: { img: ["cid"] },
    allowedStyles: {
      "*": {
        color: [/^#[0-9a-f]{3,8}$/i, /^rgba?\(/i, /^[a-z]+$/i],
        "background-color": [/^#[0-9a-f]{3,8}$/i, /^rgba?\(/i, /^[a-z]+$/i],
        border: [/^(?:0|\d+(?:\.\d+)?px (?:solid|dashed) #[0-9a-f]{3,8})$/i],
        "border-bottom": [/^(?:0|\d+(?:\.\d+)?px (?:solid|dashed) #[0-9a-f]{3,8})$/i],
        "border-left": [/^(?:0|\d+(?:\.\d+)?px (?:solid|dashed) #[0-9a-f]{3,8})$/i],
        "border-radius": [/^\d+(?:\.\d+)?(?:px|%)$/],
        "border-collapse": [/^(?:collapse|separate)$/],
        "border-spacing": [/^\d+(?:\.\d+)?(?:px|pt|em|rem|%)?$/],
        "font-family": [/^[\w\s,'"-]+$/],
        "font-size": [/^\d+(?:\.\d+)?(?:px|pt|em|rem|%)$/],
        "font-style": [/^(?:normal|italic)$/],
        "font-weight": [/^(?:normal|bold|[1-9]00)$/],
        "line-height": [/^\d+(?:\.\d+)?(?:px|em|rem|%)?$/],
        "list-style-type": [/^[a-z-]+$/],
        margin: [/^(?:0|\d+(?:\.\d+)?(?:px|pt|em|rem|%))(?:\s+(?:0|\d+(?:\.\d+)?(?:px|pt|em|rem|%))){0,3}$/],
        "margin-left": [/^\d+(?:\.\d+)?(?:px|em|rem|%)$/],
        "overflow-wrap": [/^(?:anywhere|break-word|normal)$/],
        padding: [/^(?:0|\d+(?:\.\d+)?(?:px|pt|em|rem|%))(?:\s+(?:0|\d+(?:\.\d+)?(?:px|pt|em|rem|%))){0,3}$/],
        "padding-left": [/^\d+(?:\.\d+)?(?:px|em|rem|%)$/],
        "padding-top": [/^\d+(?:\.\d+)?(?:px|pt|em|rem|%)$/],
        "text-align": [/^(?:left|right|center)$/],
        "text-decoration": [/^[a-z\s-]+$/],
        "vertical-align": [/^(?:top|middle|bottom|baseline)$/],
        "word-break": [/^(?:normal|break-all|break-word)$/],
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

function renderDaylineInvitationHtml(data: DaylineInvitationTemplateData, signatureHtml: string): string {
  const recipient = escapeMailHtml(data.recipient);
  const inviterName = escapeMailHtml(data.inviterName);
  const inviterEmail = escapeMailHtml(data.inviterEmail);
  const roleLabel = escapeMailHtml(data.roleLabel);
  const expiresAtLabel = escapeMailHtml(data.expiresAtLabel);
  const inviteUrl = escapeMailHtml(data.inviteUrl);
  const signature = signatureHtml.trim()
    ? `<div class="dayline-invitation-signature">${signatureHtml}</div>`
    : "";
  return `
    <table class="dayline-invitation-email" role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tbody><tr><td align="center" style="padding:24px 12px">
        <table class="dayline-invitation-frame" role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" align="center">
          <tbody>
            <tr><td class="dayline-invitation-header">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tbody><tr>
                <td class="dayline-invitation-logo" width="42" align="center" valign="middle">&#10022;</td>
                <td class="dayline-invitation-brand" valign="middle">
                  <div class="dayline-invitation-brand-name">Dayline</div>
                  <div class="dayline-invitation-brand-tagline">Quiet Intelligence</div>
                </td>
              </tr></tbody></table>
            </td></tr>
            <tr><td class="dayline-invitation-content">
              <p class="dayline-invitation-title">Einladung zu Dayline</p>
              <p class="dayline-invitation-greeting">Hallo ${recipient},</p>
              <p class="dayline-invitation-copy">${inviterName} lädt Sie zum Dayline-Arbeitsbereich ein, um E-Mails, Kalender, Aufgaben, Projekte und Notizen gemeinsam zu verwalten.</p>
              <table class="dayline-invitation-details" role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tbody><tr>
                  <td class="dayline-invitation-detail" width="33%">
                    <div class="dayline-invitation-label">Eingeladen von</div>
                    <div class="dayline-invitation-value">${inviterName}</div>
                    <div class="dayline-invitation-label">${inviterEmail}</div>
                  </td>
                  <td class="dayline-invitation-detail dayline-invitation-detail-border" width="33%">
                    <div class="dayline-invitation-label">Kontorolle</div>
                    <div class="dayline-invitation-value">${roleLabel}</div>
                  </td>
                  <td class="dayline-invitation-detail dayline-invitation-detail-border" width="34%">
                    <div class="dayline-invitation-label">Gültig bis</div>
                    <div class="dayline-invitation-value">${expiresAtLabel}</div>
                  </td>
                </tr></tbody>
              </table>
              <table class="dayline-invitation-action" role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tbody><tr><td class="dayline-invitation-button-cell">
                  <a class="dayline-invitation-button" href="${inviteUrl}">Einladung annehmen</a>
                </td></tr></tbody>
              </table>
              <p class="dayline-invitation-help">Falls sich die Schaltfläche nicht öffnen lässt, kopieren Sie bitte den folgenden Link in Ihren Browser:</p>
              <a class="dayline-invitation-url" href="${inviteUrl}">${inviteUrl}</a>
              <p class="dayline-invitation-security">Wenn Sie die einladende Person nicht kennen, können Sie diese E-Mail ignorieren.</p>
              ${signature}
            </td></tr>
            <tr><td class="dayline-invitation-footer">Dayline · Quiet Intelligence</td></tr>
          </tbody>
        </table>
      </td></tr></tbody>
    </table>`;
}

function escapeMailHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
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
