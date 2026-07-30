"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type MailAssistantAction = "summarize" | "extract-actions" | "draft-reply";

export interface MailAssistantResult {
  readonly messageId: string;
  readonly action: MailAssistantAction;
  readonly text: string;
  readonly modelName: string;
  readonly usedFallback: boolean;
}

export interface MailAssistantSnapshot {
  readonly kind: "mail";
  readonly hasAccounts: boolean;
  readonly loading: boolean;
  readonly message?: {
    readonly id: string;
    readonly subject: string;
    readonly sender: string;
    readonly senderAddress: string;
    readonly accountName: string;
    readonly receivedAt: string;
    readonly preview: string;
  };
  readonly aiBusy?: MailAssistantAction;
  readonly actionBusy: boolean;
  readonly result?: MailAssistantResult;
  readonly notice?: string;
}

export type WorkspaceAssistantSnapshot = MailAssistantSnapshot;

export type WorkspaceAssistantCommand =
  | { readonly type: "mail.run-ai"; readonly action: MailAssistantAction }
  | { readonly type: "mail.create-task" }
  | { readonly type: "mail.clear-result" };

type WorkspaceAssistantCommandHandler = (command: WorkspaceAssistantCommand) => void;

interface WorkspaceAssistantContextValue {
  readonly snapshot?: WorkspaceAssistantSnapshot;
  readonly publish: (snapshot?: WorkspaceAssistantSnapshot) => void;
  readonly registerCommandHandler: (handler: WorkspaceAssistantCommandHandler) => () => void;
  readonly sendCommand: (command: WorkspaceAssistantCommand) => void;
}

const WorkspaceAssistantContext = createContext<WorkspaceAssistantContextValue | undefined>(undefined);

export function WorkspaceAssistantProvider({ children }: { readonly children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<WorkspaceAssistantSnapshot>();
  const commandHandlerRef = useRef<WorkspaceAssistantCommandHandler | undefined>(undefined);

  const publish = useCallback((next?: WorkspaceAssistantSnapshot) => setSnapshot(next), []);
  const registerCommandHandler = useCallback((handler: WorkspaceAssistantCommandHandler) => {
    commandHandlerRef.current = handler;
    return () => {
      if (commandHandlerRef.current === handler) commandHandlerRef.current = undefined;
    };
  }, []);
  const sendCommand = useCallback((command: WorkspaceAssistantCommand) => {
    commandHandlerRef.current?.(command);
  }, []);

  const value = useMemo<WorkspaceAssistantContextValue>(() => ({
    snapshot,
    publish,
    registerCommandHandler,
    sendCommand,
  }), [publish, registerCommandHandler, sendCommand, snapshot]);

  return <WorkspaceAssistantContext.Provider value={value}>{children}</WorkspaceAssistantContext.Provider>;
}

export function useWorkspaceAssistant(): WorkspaceAssistantContextValue {
  const value = useContext(WorkspaceAssistantContext);
  if (!value) throw new Error("useWorkspaceAssistant must be used inside WorkspaceAssistantProvider");
  return value;
}
