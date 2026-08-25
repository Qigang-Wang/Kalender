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
        <ToolbarButton pressed={open} tooltip="mehr Werkzeuge" aria-label="mehr Werkzeuge">
          <MoreHorizontalIcon />
        </ToolbarButton>
      </PopoverTrigger>

      <PopoverContent
        className="ignore-click-outside/toolbar max-h-[var(--radix-popover-content-available-height)] w-[min(430px,calc(100vw-24px))] gap-3 overflow-y-auto p-3"
        align="end"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <MoreSection title="Format und Layout">
          <MoreTool label="Bytes"><FontSizeToolbarButton /></MoreTool>
          <MoreTool label="Zeilencode">
            <MarkToolbarButton nodeType={KEYS.code} tooltip="Zeilencode">
              <Code2Icon />
            </MarkToolbarButton>
          </MoreTool>
          <MoreTool label="Ausrichtung"><AlignToolbarButton /></MoreTool>
          <MoreTool label="Zeilenhöhe"><LineHeightToolbarButton /></MoreTool>
          <MoreTool label="Einrückung verringern"><OutdentToolbarButton /></MoreTool>
          <MoreTool label="Einrückung erhöhen"><IndentToolbarButton /></MoreTool>
          <MoreTool label="Faltblöcke"><ToggleToolbarButton /></MoreTool>
          <MoreTool label="Emoji"><EmojiToolbarButton /></MoreTool>
          <MoreTool label="Tastaturtext">
            <MarkToolbarButton nodeType={KEYS.kbd} tooltip="Tastaturtext">
              <KeyboardIcon />
            </MarkToolbarButton>
          </MoreTool>
          <MoreTool label="Superskript">
            <MarkToolbarButton nodeType={KEYS.sup} tooltip="Superskript">
              <SuperscriptIcon />
            </MarkToolbarButton>
          </MoreTool>
          <MoreTool label="Subskript">
            <MarkToolbarButton nodeType={KEYS.sub} tooltip="Subskript">
              <SubscriptIcon />
            </MarkToolbarButton>
          </MoreTool>
        </MoreSection>

        <MoreSection title="Dokument">
          <MoreTool label="Einfuhr"><ImportToolbarButton /></MoreTool>
          <MoreTool label="Exportieren"><ExportToolbarButton /></MoreTool>
        </MoreSection>

        <MoreSection title="KI, Kommentar und Zusammenarbeit">
          <MoreTool label="KI (erwartet)">
            <AIToolbarButton>
              <WandSparklesIcon />
            </AIToolbarButton>
          </MoreTool>
          <MoreTool label="Bemerkungen"><CommentToolbarButton /></MoreTool>
          <MoreTool label="Kooperationsmodus"><ModeToolbarButton /></MoreTool>
        </MoreSection>

        <MoreSection title="Hochladen">
          <MoreTool label="Bilder"><MediaToolbarButton nodeType={KEYS.img} /></MoreTool>
          <MoreTool label="Video"><MediaToolbarButton nodeType={KEYS.video} /></MoreTool>
          <MoreTool label="Audio"><MediaToolbarButton nodeType={KEYS.audio} /></MoreTool>
          <MoreTool label="Dateien"><MediaToolbarButton nodeType={KEYS.file} /></MoreTool>
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
