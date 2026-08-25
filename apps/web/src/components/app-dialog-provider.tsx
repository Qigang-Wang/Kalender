"use client";

import { CircleHelp, Info, TriangleAlert } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type DialogTone = "default" | "danger";

interface ConfirmOptions {
  readonly title: string;
  readonly description?: string;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  readonly tone?: DialogTone;
}

interface PromptOptions {
  readonly title: string;
  readonly description?: string;
  readonly defaultValue?: string;
  readonly placeholder?: string;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  readonly selectOnFocus?: boolean;
  readonly tone?: DialogTone;
}

interface AlertOptions {
  readonly title: string;
  readonly description?: string;
  readonly confirmLabel?: string;
  readonly tone?: DialogTone;
}

type DialogRequest =
  | (ConfirmOptions & {
      readonly id: number;
      readonly kind: "confirm";
      readonly resolve: (value: boolean) => void;
    })
  | (PromptOptions & {
      readonly id: number;
      readonly kind: "prompt";
      readonly resolve: (value: string | null) => void;
    })
  | (AlertOptions & {
      readonly id: number;
      readonly kind: "alert";
      readonly resolve: () => void;
    });

let nextDialogId = 1;
let dialogQueue: readonly DialogRequest[] = [];
const dialogListeners = new Set<() => void>();

function notifyDialogListeners() {
  dialogListeners.forEach((listener) => listener());
}

function enqueueDialog<T extends DialogRequest>(request: T) {
  dialogQueue = [...dialogQueue, request];
  notifyDialogListeners();
}

function settleDialog(id: number, value: boolean | string | null) {
  const request = dialogQueue.find((entry) => entry.id === id);
  if (!request) return;
  dialogQueue = dialogQueue.filter((entry) => entry.id !== id);
  notifyDialogListeners();
  queueMicrotask(() => {
    if (request.kind === "alert") request.resolve();
    else if (request.kind === "confirm") request.resolve(Boolean(value));
    else request.resolve(typeof value === "string" ? value : null);
  });
}

function subscribeToDialogs(listener: () => void) {
  dialogListeners.add(listener);
  return () => dialogListeners.delete(listener);
}

function currentDialog() {
  return dialogQueue[0] ?? null;
}

export function appConfirm(options: ConfirmOptions): Promise<boolean> {
  if (typeof window === "undefined") return Promise.resolve(false);
  return new Promise((resolve) => {
    enqueueDialog({ ...options, id: nextDialogId++, kind: "confirm", resolve });
  });
}

export function appPrompt(options: PromptOptions): Promise<string | null> {
  if (typeof window === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    enqueueDialog({ ...options, id: nextDialogId++, kind: "prompt", resolve });
  });
}

export function appAlert(options: AlertOptions): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  return new Promise((resolve) => {
    enqueueDialog({ ...options, id: nextDialogId++, kind: "alert", resolve });
  });
}

export function AppDialogProvider({ children }: { readonly children: React.ReactNode }) {
  const request = useSyncExternalStore(subscribeToDialogs, currentDialog, () => null);
  const [inputValue, setInputValue] = useState("");

  useEffect(() => {
    setInputValue(request?.kind === "prompt" ? request.defaultValue ?? "" : "");
  }, [request?.id, request?.kind]);

  const cancel = () => {
    if (!request) return;
    settleDialog(request.id, request.kind === "confirm" ? false : null);
  };

  const acceptDialog = () => {
    if (!request) return;
    settleDialog(request.id, request.kind === "prompt" ? inputValue : true);
  };

  const Icon = request?.kind === "alert"
    ? request.tone === "danger" ? TriangleAlert : Info
    : request?.tone === "danger" ? TriangleAlert : CircleHelp;

  return (
    <>
      {children}
      <AlertDialog open={Boolean(request)} onOpenChange={(open) => { if (!open) cancel(); }}>
        {request ? (
          <AlertDialogContent className="app-dialog-content">
            <AlertDialogHeader>
              <AlertDialogMedia className={request.tone === "danger" ? "text-destructive" : "text-primary"}>
                <Icon />
              </AlertDialogMedia>
              <AlertDialogTitle>{request.title}</AlertDialogTitle>
              {request.description ? (
                <AlertDialogDescription className="whitespace-pre-line">
                  {request.description}
                </AlertDialogDescription>
              ) : null}
            </AlertDialogHeader>
            {request.kind === "prompt" ? (
              <form
                id="app-dialog-prompt-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  acceptDialog();
                }}
              >
                <Input
                  aria-label={request.title}
                  autoFocus
                  placeholder={request.placeholder}
                  value={inputValue}
                  onChange={(event) => setInputValue(event.target.value)}
                  onFocus={(event) => {
                    if (request.selectOnFocus) event.currentTarget.select();
                  }}
                />
              </form>
            ) : null}
            <AlertDialogFooter className="bg-transparent">
              {request.kind !== "alert" ? (
                <Button variant="outline" onClick={cancel}>
                  {request.cancelLabel ?? "Abbrechen"}
                </Button>
              ) : null}
              <Button
                form={request.kind === "prompt" ? "app-dialog-prompt-form" : undefined}
                type={request.kind === "prompt" ? "submit" : "button"}
                variant={request.tone === "danger" ? "destructive" : "default"}
                onClick={request.kind === "prompt" ? undefined : acceptDialog}
              >
                {request.confirmLabel ?? (request.kind === "alert" ? "Verstanden" : "Bestätigen")}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        ) : null}
      </AlertDialog>
    </>
  );
}
