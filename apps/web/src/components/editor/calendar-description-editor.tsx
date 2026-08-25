'use client';

import type { Value } from 'platejs';

import { BoldIcon, ExternalLink, ItalicIcon, Video } from 'lucide-react';
import { KEYS, TrailingBlockPlugin } from 'platejs';
import {
  createPlatePlugin,
  ParagraphPlugin,
  Plate,
  usePlateEditor,
} from 'platejs/react';
import { useEffect, useRef } from 'react';

import { AutoformatKit } from '@/components/editor/plugins/autoformat-kit';
import { BasicMarksKit } from '@/components/editor/plugins/basic-marks-kit';
import { LinkKit } from '@/components/editor/plugins/link-kit';
import { ListKit } from '@/components/editor/plugins/list-kit';
import { Editor, EditorContainer } from '@/components/ui/editor';
import { FixedToolbar } from '@/components/ui/fixed-toolbar';
import { RedoToolbarButton, UndoToolbarButton } from '@/components/ui/history-toolbar-button';
import { LinkToolbarButton } from '@/components/ui/link-toolbar-button';
import {
  BulletedListToolbarButton,
  NumberedListToolbarButton,
  TodoListToolbarButton,
} from '@/components/ui/list-toolbar-button';
import { MarkToolbarButton } from '@/components/ui/mark-toolbar-button';
import { ParagraphElement } from '@/components/ui/paragraph-node';
import { ToolbarGroup } from '@/components/ui/toolbar';
import { calendarDescriptionLinks } from '@/lib/calendar-description';
import {
  decodeNoteContent,
  encodeNoteContent,
  type PlateNoteValue,
} from '@/lib/note-content';

const CalendarDescriptionBaseKit = [
  ParagraphPlugin.withComponent(ParagraphElement),
  ...BasicMarksKit,
  ...ListKit,
  ...LinkKit,
  ...AutoformatKit,
  TrailingBlockPlugin,
];

const CalendarDescriptionToolbarKit = [
  createPlatePlugin({
    key: 'calendar-description-toolbar',
    render: {
      beforeEditable: () => (
        <FixedToolbar className="calendar-rich-toolbar" aria-label="Formatierungsleiste für Terminnotizen">
          <ToolbarGroup>
            <UndoToolbarButton />
            <RedoToolbarButton />
          </ToolbarGroup>
          <ToolbarGroup>
            <MarkToolbarButton aria-label="dicker" nodeType={KEYS.bold} tooltip="dicker"><BoldIcon /></MarkToolbarButton>
            <MarkToolbarButton aria-label="kursiv" nodeType={KEYS.italic} tooltip="kursiv"><ItalicIcon /></MarkToolbarButton>
          </ToolbarGroup>
          <ToolbarGroup>
            <BulletedListToolbarButton />
            <NumberedListToolbarButton />
            <TodoListToolbarButton aria-label="Checkliste" tooltip="Checkliste" />
            <LinkToolbarButton aria-label="Verknüpfungen einfügen" />
          </ToolbarGroup>
        </FixedToolbar>
      ),
    },
  }),
];

const CalendarDescriptionEditorKit = [
  ...CalendarDescriptionBaseKit,
  ...CalendarDescriptionToolbarKit,
];

export function CalendarDescriptionEditor({
  eventKey,
  content,
  disabled,
  onChange,
}: {
  readonly eventKey: string;
  readonly content: string;
  readonly disabled?: boolean;
  readonly onChange: (content: string) => void;
}) {
  const onChangeRef = useRef(onChange);
  const observedContent = useRef(content);
  const applyingExternalValue = useRef(false);
  onChangeRef.current = onChange;

  const editor = usePlateEditor({
    plugins: CalendarDescriptionEditorKit,
    value: decodeNoteContent(content) as Value,
  }, [eventKey]);

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
      <div className="calendar-rich-editor-shell">
        <EditorContainer className="calendar-rich-editor">
          <Editor
            className="calendar-rich-content"
            variant="none"
            aria-label="Terminnotiz"
            disabled={disabled}
            placeholder="Agenda hinzufügen, Veranstaltungen vorbereiten, Links oder Protokolle von Sitzungen"
          />
        </EditorContainer>
        <CalendarDescriptionLinkRow content={content} />
      </div>
    </Plate>
  );
}

export function CalendarDescriptionView({
  eventKey,
  content,
}: {
  readonly eventKey: string;
  readonly content: string;
}) {
  const editor = usePlateEditor({
    plugins: CalendarDescriptionBaseKit,
    value: decodeNoteContent(content) as Value,
  }, [eventKey]);

  return (
    <>
      <CalendarDescriptionLinkRow content={content} />
      <Plate readOnly editor={editor}>
        <EditorContainer className="calendar-rich-view">
          <Editor className="calendar-rich-view-content" variant="none" aria-label="Terminnotizen" />
        </EditorContainer>
      </Plate>
    </>
  );
}

function CalendarDescriptionLinkRow({ content }: { readonly content: string }) {
  const links = calendarDescriptionLinks(content);
  if (!links.length) return null;
  return (
    <div className="calendar-rich-links" aria-label="anerkannte Verknüpfungen">
      {links.map((link) => (
        <a href={link.url} target="_blank" rel="noreferrer" title={link.url} key={link.url}>
          {link.meeting ? <Video size={13} /> : <ExternalLink size={13} />}
          <span>{link.label}</span>
          <small>{new URL(link.url).hostname}</small>
        </a>
      ))}
    </div>
  );
}
