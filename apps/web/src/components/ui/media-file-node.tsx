'use client';

import * as React from 'react';

import type { TFileElement } from 'platejs';
import type { PlateElementProps } from 'platejs/react';

import { useMediaState } from '@platejs/media/react';
import { ResizableProvider } from '@platejs/resizable';
import { Download, FileUp, Trash2 } from 'lucide-react';
import { PlateElement, useReadOnly, useRemoveNodeButton, withHOC } from 'platejs/react';

import { cn } from '@/lib/utils';
import { Caption, CaptionTextarea } from './caption';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from './context-menu';

export const FileElement = withHOC(
  ResizableProvider,
  function FileElement(props: PlateElementProps<TFileElement>) {
    const readOnly = useReadOnly();
    const { name, unsafeUrl } = useMediaState();
    const { props: removeButtonProps } = useRemoveNodeButton({ element: props.element });

    return (
      <PlateElement className="my-px rounded-sm" {...props}>
        <ContextMenu modal={false}>
          <ContextMenuTrigger asChild onContextMenu={(event) => event.stopPropagation()}>
            <a
              className={cn(
                'group relative m-0 flex cursor-pointer items-center rounded px-0.5 py-[3px] hover:bg-muted'
              )}
              contentEditable={false}
              download={name}
              href={unsafeUrl}
              rel="noopener noreferrer"
              role="button"
              target="_blank"
            >
              <div className={cn('flex items-center gap-1 p-1')}>
                <FileUp className="size-5" />
                <div>{name}</div>
              </div>

              <Caption align="left">
                <CaptionTextarea
                  className="text-left"
                  readOnly={readOnly}
                  placeholder="Write a caption..."
                />
              </Caption>
            </a>
          </ContextMenuTrigger>
          <ContextMenuContent className="w-56" contentEditable={false} aria-label="文件操作">
            <ContextMenuItem asChild>
              <a href={unsafeUrl} download={name} target="_blank" rel="noopener noreferrer">
                <Download />
                下载
              </a>
            </ContextMenuItem>
            {!readOnly && (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem variant="destructive" onClick={removeButtonProps.onClick}>
                  <Trash2 />
                  从笔记移除
                </ContextMenuItem>
              </>
            )}
          </ContextMenuContent>
        </ContextMenu>
        {props.children}
      </PlateElement>
    );
  }
);
