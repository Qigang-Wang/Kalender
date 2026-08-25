'use client';

import type { Value } from 'platejs';

import {
  BaselineIcon,
  BoldIcon,
  ItalicIcon,
  PaintBucketIcon,
  StrikethroughIcon,
  UnderlineIcon,
} from 'lucide-react';
import { KEYS, TrailingBlockPlugin } from 'platejs';
import { createPlatePlugin, Plate, usePlateEditor } from 'platejs/react';
import { useEffect, useRef } from 'react';

import { AutoformatKit } from '@/components/editor/plugins/autoformat-kit';
import { BasicMarksKit } from '@/components/editor/plugins/basic-marks-kit';
import { FontKit } from '@/components/editor/plugins/font-kit';
import { LinkKit } from '@/components/editor/plugins/link-kit';
import { ListKit } from '@/components/editor/plugins/list-kit';
import { MediaKit } from '@/components/editor/plugins/media-kit';
import { FontColorToolbarButton } from '@/components/ui/font-color-toolbar-button';
import { FixedToolbar } from '@/components/ui/fixed-toolbar';
import { RedoToolbarButton, UndoToolbarButton } from '@/components/ui/history-toolbar-button';
import { LinkToolbarButton } from '@/components/ui/link-toolbar-button';
import { BulletedListToolbarButton, NumberedListToolbarButton } from '@/components/ui/list-toolbar-button';
import { MarkToolbarButton } from '@/components/ui/mark-toolbar-button';
import { ParagraphElement } from '@/components/ui/paragraph-node';
import { ToolbarGroup } from '@/components/ui/toolbar';
import { Editor, EditorContainer } from '@/components/ui/editor';
import { decodeNoteContent, encodeNoteContent, type PlateNoteValue } from '@/lib/note-content';
import { ParagraphPlugin } from 'platejs/react';

const MailToolbarKit = [
  createPlatePlugin({
    key: 'mail-fixed-toolbar',
    render: {
      beforeEditable: () => (
        <FixedToolbar className="mail-compose-toolbar" aria-label="Werkzeugleiste für das Mailformat">
          <ToolbarGroup>
            <UndoToolbarButton />
            <RedoToolbarButton />
          </ToolbarGroup>
          <ToolbarGroup>
            <MarkToolbarButton aria-label="dicker" nodeType={KEYS.bold} tooltip="dicker (B)"><BoldIcon /></MarkToolbarButton>
            <MarkToolbarButton aria-label="kursiv" nodeType={KEYS.italic} tooltip="kursiv (I)"><ItalicIcon /></MarkToolbarButton>
            <MarkToolbarButton aria-label="unterstrichen" nodeType={KEYS.underline} tooltip="Unterstrichen ()"><UnderlineIcon /></MarkToolbarButton>
            <MarkToolbarButton aria-label="Streik" nodeType={KEYS.strikethrough} tooltip="Streik"><StrikethroughIcon /></MarkToolbarButton>
            <FontColorToolbarButton nodeType={KEYS.color} tooltip="Farbe des Textes"><BaselineIcon /></FontColorToolbarButton>
            <FontColorToolbarButton nodeType={KEYS.backgroundColor} tooltip="Hintergrundfarbe"><PaintBucketIcon /></FontColorToolbarButton>
          </ToolbarGroup>
          <ToolbarGroup>
            <NumberedListToolbarButton />
            <BulletedListToolbarButton />
            <LinkToolbarButton aria-label="Verknüpfungen einfügen" />
          </ToolbarGroup>
        </FixedToolbar>
      ),
    },
  }),
];

const MailEditorKit = [
  ParagraphPlugin.withComponent(ParagraphElement),
  ...BasicMarksKit,
  ...FontKit,
  ...ListKit,
  ...LinkKit,
  ...MediaKit,
  ...AutoformatKit,
  TrailingBlockPlugin,
  ...MailToolbarKit,
];

export function MailComposerEditor({
  draftId,
  content,
  disabled,
  onPasteImages,
  onChange,
}: {
  readonly draftId: string;
  readonly content: string;
  readonly disabled?: boolean;
  readonly onPasteImages?: (files: readonly File[]) => Promise<readonly {
    readonly attachmentId: string;
    readonly filename: string;
    readonly url: string;
  }[]>;
  readonly onChange: (content: string) => void;
}) {
  const onChangeRef = useRef(onChange);
  const observedContent = useRef(content);
  const applyingExternalValue = useRef(false);
  onChangeRef.current = onChange;

  const editor = usePlateEditor({
    plugins: MailEditorKit,
    value: decodeNoteContent(content) as Value,
  }, [draftId]);

  useEffect(() => {
    if (observedContent.current === content) return;
    observedContent.current = content;
    const current = encodeNoteContent(editor.children as PlateNoteValue);
    if (current === content) return;
    applyingExternalValue.current = true;
    editor.tf.setValue(decodeNoteContent(content) as Value);
    applyingExternalValue.current = false;
  }, [content, editor]);

  return (
    <Plate
      editor={editor}
      onChange={({ value }) => {
        if (applyingExternalValue.current) return;
        const encoded = encodeNoteContent(value as PlateNoteValue);
        if (encoded === observedContent.current) return;
        observedContent.current = encoded;
        onChangeRef.current(encoded);
      }}
    >
      <EditorContainer className="mail-plate-editor">
        <Editor
          className="mail-compose-content"
          variant="none"
        aria-label="E-Mail-Stelle"
        disabled={disabled}
        placeholder="Mail-Inhalte schreiben..."
        autoFocus
        onPaste={(event) => {
          if (!onPasteImages || disabled) return;
          const files = Array.from(event.clipboardData.items)
            .filter((item) => item.kind === 'file' && /^image\/(?:png|jpe?g|gif|webp)$/i.test(item.type))
            .map((item) => item.getAsFile())
            .filter((file): file is File => Boolean(file));
          if (!files.length) return;
          event.preventDefault();
          void onPasteImages(files).then((images) => {
            for (const image of images) {
              editor.tf.insertNodes({
                type: KEYS.img,
                url: image.url,
                attachmentId: image.attachmentId,
                name: image.filename,
                align: 'left',
                children: [{ text: '' }],
              });
            }
          });
        }}
      />
      </EditorContainer>
    </Plate>
  );
}
