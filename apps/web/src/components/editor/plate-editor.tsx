'use client';

import type { Value } from 'platejs';

import { Plate, usePlateEditor } from 'platejs/react';
import { useEffect, useRef } from 'react';

import { EditorKit } from '@/components/editor/editor-kit';
import { Editor, EditorContainer } from '@/components/ui/editor';
import {
  decodeNoteContent,
  encodeNoteContent,
  type PlateNoteValue,
} from '@/lib/note-content';

interface PlateNoteEditorProps {
  readonly noteId: string;
  readonly content: string;
  readonly onChange: (content: string) => void;
}

export function PlateNoteEditor({ noteId, content, onChange }: PlateNoteEditorProps) {
  const onChangeRef = useRef(onChange);
  const observedContent = useRef(content);
  const loadedNoteId = useRef(noteId);
  const applyingExternalValue = useRef(false);

  onChangeRef.current = onChange;

  if (loadedNoteId.current !== noteId) {
    loadedNoteId.current = noteId;
    observedContent.current = content;
  }

  const editor = usePlateEditor(
    {
      plugins: EditorKit,
      value: decodeNoteContent(content) as Value,
    },
    [noteId],
  );

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
      <EditorContainer className="note-plate-editor">
        <Editor
          className="note-plate-content"
          variant="fullWidth"
          aria-label="Notizkörper"
        />
      </EditorContainer>
    </Plate>
  );
}
