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
        <FixedToolbar className="mail-compose-toolbar" aria-label="邮件格式工具栏">
          <ToolbarGroup>
            <UndoToolbarButton />
            <RedoToolbarButton />
          </ToolbarGroup>
          <ToolbarGroup>
            <MarkToolbarButton aria-label="加粗" nodeType={KEYS.bold} tooltip="加粗 (⌘+B)"><BoldIcon /></MarkToolbarButton>
            <MarkToolbarButton aria-label="斜体" nodeType={KEYS.italic} tooltip="斜体 (⌘+I)"><ItalicIcon /></MarkToolbarButton>
            <MarkToolbarButton aria-label="下划线" nodeType={KEYS.underline} tooltip="下划线 (⌘+U)"><UnderlineIcon /></MarkToolbarButton>
            <MarkToolbarButton aria-label="删除线" nodeType={KEYS.strikethrough} tooltip="删除线"><StrikethroughIcon /></MarkToolbarButton>
            <FontColorToolbarButton nodeType={KEYS.color} tooltip="文字颜色"><BaselineIcon /></FontColorToolbarButton>
            <FontColorToolbarButton nodeType={KEYS.backgroundColor} tooltip="背景颜色"><PaintBucketIcon /></FontColorToolbarButton>
          </ToolbarGroup>
          <ToolbarGroup>
            <NumberedListToolbarButton />
            <BulletedListToolbarButton />
            <LinkToolbarButton aria-label="插入链接" />
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
        aria-label="邮件正文"
        disabled={disabled}
        placeholder="写下邮件内容…"
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
