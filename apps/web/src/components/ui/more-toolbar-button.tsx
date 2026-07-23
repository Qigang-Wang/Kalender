'use client';

import * as React from 'react';

import {
  Code2Icon,
  KeyboardIcon,
  MoreHorizontalIcon,
  SubscriptIcon,
  SuperscriptIcon,
  WandSparklesIcon,
} from 'lucide-react';
import { KEYS } from 'platejs';

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';

import { AIToolbarButton } from './ai-toolbar-button';
import { AlignToolbarButton } from './align-toolbar-button';
import { CommentToolbarButton } from './comment-toolbar-button';
import { EmojiToolbarButton } from './emoji-toolbar-button';
import { ExportToolbarButton } from './export-toolbar-button';
import { FontSizeToolbarButton } from './font-size-toolbar-button';
import { ImportToolbarButton } from './import-toolbar-button';
import {
  IndentToolbarButton,
  OutdentToolbarButton,
} from './indent-toolbar-button';
import { LineHeightToolbarButton } from './line-height-toolbar-button';
import { MarkToolbarButton } from './mark-toolbar-button';
import { MediaToolbarButton } from './media-toolbar-button';
import { ModeToolbarButton } from './mode-toolbar-button';
import { ToggleToolbarButton } from './toggle-toolbar-button';
import { ToolbarButton } from './toolbar';

export function MoreToolbarButton() {
  const [open, setOpen] = React.useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen} modal={false}>
      <PopoverTrigger asChild>
        <ToolbarButton pressed={open} tooltip="更多工具" aria-label="更多工具">
          <MoreHorizontalIcon />
        </ToolbarButton>
      </PopoverTrigger>

      <PopoverContent
        className="ignore-click-outside/toolbar max-h-[var(--radix-popover-content-available-height)] w-[min(430px,calc(100vw-24px))] gap-3 overflow-y-auto p-3"
        align="end"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <MoreSection title="格式与排版">
          <MoreTool label="字号"><FontSizeToolbarButton /></MoreTool>
          <MoreTool label="行内代码">
            <MarkToolbarButton nodeType={KEYS.code} tooltip="行内代码">
              <Code2Icon />
            </MarkToolbarButton>
          </MoreTool>
          <MoreTool label="对齐"><AlignToolbarButton /></MoreTool>
          <MoreTool label="行高"><LineHeightToolbarButton /></MoreTool>
          <MoreTool label="减少缩进"><OutdentToolbarButton /></MoreTool>
          <MoreTool label="增加缩进"><IndentToolbarButton /></MoreTool>
          <MoreTool label="折叠块"><ToggleToolbarButton /></MoreTool>
          <MoreTool label="Emoji"><EmojiToolbarButton /></MoreTool>
          <MoreTool label="键盘文本">
            <MarkToolbarButton nodeType={KEYS.kbd} tooltip="键盘文本">
              <KeyboardIcon />
            </MarkToolbarButton>
          </MoreTool>
          <MoreTool label="上标">
            <MarkToolbarButton nodeType={KEYS.sup} tooltip="上标">
              <SuperscriptIcon />
            </MarkToolbarButton>
          </MoreTool>
          <MoreTool label="下标">
            <MarkToolbarButton nodeType={KEYS.sub} tooltip="下标">
              <SubscriptIcon />
            </MarkToolbarButton>
          </MoreTool>
        </MoreSection>

        <MoreSection title="文档">
          <MoreTool label="导入"><ImportToolbarButton /></MoreTool>
          <MoreTool label="导出"><ExportToolbarButton /></MoreTool>
        </MoreSection>

        <MoreSection title="AI、评论与协作">
          <MoreTool label="AI（即将接入）">
            <AIToolbarButton>
              <WandSparklesIcon />
            </AIToolbarButton>
          </MoreTool>
          <MoreTool label="评论"><CommentToolbarButton /></MoreTool>
          <MoreTool label="协作模式"><ModeToolbarButton /></MoreTool>
        </MoreSection>

        <MoreSection title="上传">
          <MoreTool label="图片"><MediaToolbarButton nodeType={KEYS.img} /></MoreTool>
          <MoreTool label="视频"><MediaToolbarButton nodeType={KEYS.video} /></MoreTool>
          <MoreTool label="音频"><MediaToolbarButton nodeType={KEYS.audio} /></MoreTool>
          <MoreTool label="文件"><MediaToolbarButton nodeType={KEYS.file} /></MoreTool>
        </MoreSection>
      </PopoverContent>
    </Popover>
  );
}

function MoreSection({ children, title }: { readonly children: React.ReactNode; readonly title: string }) {
  return (
    <section className="space-y-1.5 border-b border-border/70 pb-3 last:border-0 last:pb-0">
      <h3 className="px-1 text-xs font-semibold text-muted-foreground">{title}</h3>
      <div className="grid grid-cols-2 gap-1.5">{children}</div>
    </section>
  );
}

function MoreTool({ children, label }: { readonly children: React.ReactNode; readonly label: string }) {
  return (
    <div className="flex min-h-9 min-w-0 items-center gap-1 rounded-md border border-transparent bg-muted/35 pr-2 transition-colors has-[button:hover]:border-border has-[button:hover]:bg-muted/70">
      <div className="flex shrink-0 items-center">{children}</div>
      <span className="min-w-0 truncate text-xs text-muted-foreground">{label}</span>
    </div>
  );
}
