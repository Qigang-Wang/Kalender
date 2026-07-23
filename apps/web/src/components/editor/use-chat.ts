'use client';

import * as React from 'react';

import { type UseChatHelpers, useChat as useBaseChat } from '@ai-sdk/react';
import {
  AIChatPlugin,
  aiCommentToRange,
  applyTableCellSuggestion,
} from '@platejs/ai/react';
import { withAIBatch } from '@platejs/ai';
import { getCommentKey, getTransientCommentKey } from '@platejs/comment';
import { deserializeMd } from '@platejs/markdown';
import { BlockSelectionPlugin } from '@platejs/selection/react';
import { DefaultChatTransport, type UIMessage } from 'ai';
import { KEYS, nanoid, NodeApi, TextApi, type TNode } from 'platejs';
import { useEditorRef, usePluginOption, type PlateEditor } from 'platejs/react';

import { aiChatPlugin } from '@/components/editor/plugins/ai-kit';

import { discussionPlugin } from './plugins/discussion-kit';

export type ToolName = 'comment' | 'edit' | 'generate';

export type TComment = {
  comment: {
    blockId: string;
    comment: string;
    content: string;
  } | null;
  status: 'finished' | 'streaming';
};

export type TTableCellUpdate = {
  cellUpdate: {
    content: string;
    id: string;
  } | null;
  status: 'finished' | 'streaming';
};

export type MessageDataPart = {
  toolName: ToolName;
  comment?: TComment;
  table?: TTableCellUpdate;
};

export type ChatMessage = UIMessage<{}, MessageDataPart>;
export type Chat = UseChatHelpers<ChatMessage>;

function createChatTransport({ api, editor }: { api: string; editor: PlateEditor }) {
  return new DefaultChatTransport<ChatMessage>({
    api,
    prepareSendMessagesRequest: ({ messages }) => ({
      body: {
        messages,
        ...editor.getOptions(aiChatPlugin).chatOptions?.body,
      },
    }),
  });
}

export const useChat = () => {
  const editor = useEditorRef();
  const options = usePluginOption(aiChatPlugin, 'chatOptions');
  const transport = React.useMemo(
    () => createChatTransport({ api: options.api || '/api/ai/command', editor }),
    [editor, options.api]
  );
  const chat = useBaseChat<ChatMessage>({
    id: 'editor',
    transport,
    onData(data) {
      if (data.type === 'data-toolName') {
        editor.setOption(AIChatPlugin, 'toolName', data.data as ToolName);
      }

      if (data.type === 'data-table' && data.data) {
        const tableData = data.data as TTableCellUpdate;
        if (tableData.status === 'finished') {
          const chatSelection = editor.getOption(AIChatPlugin, 'chatSelection');
          if (!chatSelection) return;
          editor.tf.setSelection(chatSelection);
          return;
        }
        withAIBatch(editor, () => {
          applyTableCellSuggestion(editor, tableData.cellUpdate!);
        });
      }

      if (data.type === 'data-comment' && data.data) {
        const commentData = data.data as TComment;
        if (commentData.status === 'finished') {
          editor.getApi(BlockSelectionPlugin).blockSelection.deselect();
          return;
        }
        const aiComment = commentData.comment!;
        const range = aiCommentToRange(editor, aiComment);
        if (!range) return console.warn('No range found for AI comment');
        const discussions = editor.getOption(discussionPlugin, 'discussions') || [];
        const discussionId = nanoid();
        const newDiscussion = {
          id: discussionId,
          comments: [{
            id: nanoid(),
            contentRich: [{ children: [{ text: aiComment.comment }], type: 'p' }],
            createdAt: new Date(),
            discussionId,
            isEdited: false,
            userId: editor.getOption(discussionPlugin, 'currentUserId'),
          }],
          createdAt: new Date(),
          documentContent: deserializeMd(editor, aiComment.content)
            .map((node: TNode) => NodeApi.string(node))
            .join('\n'),
          isResolved: false,
          userId: editor.getOption(discussionPlugin, 'currentUserId'),
        };
        editor.setOption(discussionPlugin, 'discussions', [...discussions, newDiscussion]);
        editor.tf.withMerging(() => {
          editor.tf.setNodes(
            {
              [getCommentKey(newDiscussion.id)]: true,
              [getTransientCommentKey()]: true,
              [KEYS.comment]: true,
            },
            { at: range, match: TextApi.isText, split: true }
          );
        });
      }
    },
    ...options,
  });

  React.useEffect(() => {
    editor.setOption(AIChatPlugin, 'chat', chat as any);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.status, chat.messages, chat.error]);

  return chat;
};
