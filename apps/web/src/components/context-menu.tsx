"use client";

import { Archive, CalendarPlus, CheckCircle2, Clock3, Copy, Download, Eye, EyeOff, FolderPlus, Info, Mail, NotebookPen, Pencil, RefreshCw, RotateCcw, Sparkles, Star, Trash2, ExternalLink } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";

import type {
  ContextCommandIcon,
  ContextCommandId,
  ResolvedContextCommand,
} from "./context-commands";

interface ContextMenuProps {
  readonly anchor: { readonly x: number; readonly y: number };
  readonly ariaLabel: string;
  readonly commands: readonly ResolvedContextCommand[];
  readonly heading?: string;
  readonly returnFocus?: HTMLElement | null;
  readonly testId?: string;
  readonly onClose: () => void;
  readonly onSelect: (commandId: ContextCommandId) => void;
}

const iconComponents = {
  archive: Archive,
  "calendar-plus": CalendarPlus,
  clock: Clock3,
  copy: Copy,
  download: Download,
  edit: Pencil,
  eye: Eye,
  "eye-off": EyeOff,
  folder: FolderPlus,
  info: Info,
  mail: Mail,
  open: ExternalLink,
  refresh: RefreshCw,
  sparkles: Sparkles,
  star: Star,
  "star-filled": Star,
  task: CheckCircle2,
  note: NotebookPen,
  restore: RotateCcw,
  trash: Trash2,
} satisfies Record<ContextCommandIcon, typeof Archive>;

export function ContextMenu({
  anchor,
  ariaLabel,
  commands,
  heading,
  returnFocus,
  testId = "context-menu",
  onClose,
  onSelect,
}: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(anchor);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const bounds = menu.getBoundingClientRect();
    setPosition({
      x: Math.max(8, Math.min(anchor.x, window.innerWidth - bounds.width - 8)),
      y: Math.max(8, Math.min(anchor.y, window.innerHeight - bounds.height - 8)),
    });
  }, [anchor]);

  useEffect(() => {
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
    const handlePointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) closeAndRestoreFocus(onClose, returnFocus);
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") closeAndRestoreFocus(onClose, returnFocus);
    };
    const close = () => closeAndRestoreFocus(onClose, returnFocus);
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [onClose, returnFocus]);

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'));
    if (!buttons.length) return;
    const currentIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex = event.key === "Home" ? 0
      : event.key === "End" ? buttons.length - 1
      : event.key === "ArrowDown" ? (currentIndex + 1 + buttons.length) % buttons.length
      : (currentIndex - 1 + buttons.length) % buttons.length;
    buttons[nextIndex]?.focus();
  };

  return (
    <div
      className="context-menu"
      data-testid={testId}
      ref={menuRef}
      role="menu"
      aria-label={ariaLabel}
      style={{ left: position.x, top: position.y }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={handleMenuKeyDown}
    >
      {heading && <div className="context-menu-heading" title={heading}>{heading}</div>}
      {commands.map((command, index) => {
        const Icon = iconComponents[command.icon];
        const showSeparator = index > 0 && commands[index - 1]?.group !== command.group;
        return (
          <div className="context-menu-entry" key={command.id}>
            {showSeparator && <div className="context-menu-separator" />}
            <button
              className={command.group === "danger" ? "context-danger" : undefined}
              role="menuitem"
              disabled={Boolean(command.disabledReason)}
              title={command.disabledReason}
              onClick={() => {
                onClose();
                onSelect(command.id);
              }}
            >
              <Icon size={16} fill={command.icon === "star-filled" ? "currentColor" : "none"} />
              {command.label}
              {command.disabledReason && <small>{command.disabledReason}</small>}
            </button>
          </div>
        );
      })}
    </div>
  );
}

function closeAndRestoreFocus(onClose: () => void, returnFocus?: HTMLElement | null) {
  onClose();
  window.requestAnimationFrame(() => returnFocus?.focus());
}
