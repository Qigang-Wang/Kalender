import { createUIMessageStream, createUIMessageStreamResponse, type UIMessage } from "ai";
import { NextResponse } from "next/server";

import {
  createAiConversation,
  createAiRun,
  listAiChatMessages,
  requireAiConversation,
  saveAiChatMessage,
  updateAiRun,
} from "@/server/ai-chat-repository";
import { aiProviderErrorResponse } from "@/server/ai-provider-api";
import { resolveAiModelRoute, type RoutedAiModel } from "@/server/ai-model-router";
import { AiProviderError, toAiPublicError } from "@/server/ai-provider-validation";
import { storedProviderConnection, streamAiChat, type AiChatInputMessage } from "@/server/openai-compatible-ai";

export const runtime = "nodejs";
export const maxDuration = 120;

interface CommandDataParts {
  [key: string]: unknown;
  conversation: { readonly id: string; readonly title: string };
  model: { readonly runId: string; readonly providerName: string; readonly modelId: string; readonly modelName: string; readonly usedFallback: boolean };
  fallback: { readonly fromModelName: string; readonly toModelName: string };
  run: { readonly runId: string; readonly status: "succeeded" | "failed" | "cancelled"; readonly latencyMs: number };
}

type CommandMessage = UIMessage<unknown, CommandDataParts>;

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    const parsed = parseChatRequest(body);
    const route = await resolveAiModelRoute({ featureKey: "assistant.default", requestedModelId: parsed.requestedModelId });
    const conversation = parsed.conversationId
      ? await requireAiConversation(parsed.conversationId)
      : await createAiConversation(parsed.prompt);
    await saveAiChatMessage({
      id: parsed.userMessageId,
      conversationId: conversation.id,
      role: "user",
      text: parsed.prompt,
    });
    const storedMessages = await listAiChatMessages(conversation.id);
    const messages = buildModelMessages(storedMessages, route.contextBudgetTokens);
    const run = await createAiRun({
      conversationId: conversation.id,
      featureKey: "assistant.default",
      providerId: route.primary.provider.id,
      modelId: route.primary.model.id,
    });
    const stream = createUIMessageStream<CommandMessage>({
      execute: async ({ writer }) => {
        const textPartId = `answer-${run.id}`;
        const startedAt = performance.now();
        let active = route.primary;
        let attemptCount = 1;
        let usedFallback = false;
        let text = "";
        let emittedText = false;
        let promptTokens: number | undefined;
        let completionTokens: number | undefined;
        writer.write({ type: "data-conversation", data: { id: conversation.id, title: conversation.title }, transient: true });
        writer.write({ type: "data-model", data: modelEvent(run.id, active, false), transient: true });
        writer.write({ type: "text-start", id: textPartId });

        const executeAttempt = async (target: RoutedAiModel) => {
          for await (const part of streamAiChat({
            provider: storedProviderConnection(target.provider),
            credential: target.credential,
            model: target.model,
            messages,
            signal: request.signal,
            timeoutMs: Math.min(route.timeoutMs, target.provider.requestTimeoutMs),
          })) {
            if (part.type === "text") {
              emittedText = true;
              text += part.text;
              writer.write({ type: "text-delta", id: textPartId, delta: part.text });
            } else {
              promptTokens = part.promptTokens ?? promptTokens;
              completionTokens = part.completionTokens ?? completionTokens;
            }
          }
        };

        try {
          try {
            await executeAttempt(active);
          } catch (primaryError) {
            if (request.signal.aborted || emittedText || !route.fallback || !fallbackEligible(primaryError)) throw primaryError;
            const previous = active;
            active = route.fallback;
            attemptCount = 2;
            usedFallback = true;
            await updateAiRun(run.id, {
              providerId: active.provider.id,
              modelId: active.model.id,
              status: "running",
              attemptCount,
              usedFallback,
            });
            writer.write({ type: "data-fallback", data: { fromModelName: previous.model.displayName, toModelName: active.model.displayName }, transient: true });
            writer.write({ type: "data-model", data: modelEvent(run.id, active, true), transient: true });
            await executeAttempt(active);
          }
          writer.write({ type: "text-end", id: textPartId });
          await saveAiChatMessage({
            conversationId: conversation.id,
            role: "assistant",
            text,
            modelId: active.model.id,
          });
          const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
          await updateAiRun(run.id, {
            providerId: active.provider.id,
            modelId: active.model.id,
            status: "succeeded",
            attemptCount,
            usedFallback,
            promptTokens,
            completionTokens,
            latencyMs,
          });
          writer.write({ type: "data-run", data: { runId: run.id, status: "succeeded", latencyMs }, transient: true });
        } catch (error) {
          const cancelled = request.signal.aborted;
          const normalized = toAiPublicError(error);
          const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
          if (text) {
            await saveAiChatMessage({
              conversationId: conversation.id,
              role: "assistant",
              text,
              modelId: active.model.id,
              status: "partial",
            });
          }
          await updateAiRun(run.id, {
            providerId: active.provider.id,
            modelId: active.model.id,
            status: cancelled ? "cancelled" : "failed",
            attemptCount,
            usedFallback,
            latencyMs,
            errorCode: cancelled ? "AI_CANCELLED" : normalized.code,
          });
          if (emittedText) writer.write({ type: "text-end", id: textPartId });
          writer.write({ type: "data-run", data: { runId: run.id, status: cancelled ? "cancelled" : "failed", latencyMs }, transient: true });
          if (!cancelled) throw normalized;
        }
      },
      onError: (error) => toAiPublicError(error).message,
    });
    return createUIMessageStreamResponse({
      stream,
      headers: { "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
    });
  } catch (error) {
    return aiProviderErrorResponse(error);
  }
}

function parseChatRequest(value: unknown): {
  readonly conversationId?: string;
  readonly requestedModelId?: string;
  readonly userMessageId: string;
  readonly prompt: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AiProviderError("请求格式无效", "INVALID_REQUEST");
  const body = value as Record<string, unknown>;
  if (!Array.isArray(body.messages) || !body.messages.length) throw new AiProviderError("请输入消息", "AI_PROMPT_REQUIRED");
  const last = body.messages[body.messages.length - 1];
  if (!last || typeof last !== "object" || Array.isArray(last)) throw new AiProviderError("消息格式无效", "INVALID_REQUEST");
  const message = last as Record<string, unknown>;
  if (message.role !== "user" || !Array.isArray(message.parts)) throw new AiProviderError("最后一条消息必须来自用户", "INVALID_REQUEST");
  const prompt = message.parts
    .filter((part): part is { type: "text"; text: string } => Boolean(part && typeof part === "object" && !Array.isArray(part) && (part as Record<string, unknown>).type === "text" && typeof (part as Record<string, unknown>).text === "string"))
    .map((part) => part.text).join("\n").trim();
  if (!prompt) throw new AiProviderError("请输入消息", "AI_PROMPT_REQUIRED");
  if (prompt.length > 20_000) throw new AiProviderError("单条消息不能超过 20,000 个字符", "AI_PROMPT_TOO_LONG", 413);
  return {
    conversationId: safeId(body.conversationId),
    requestedModelId: safeId(body.requestedModelId),
    userMessageId: safeId(message.id) ?? crypto.randomUUID(),
    prompt,
  };
}

function safeId(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const id = value.trim();
  if (id.length > 100 || !/^[A-Za-z0-9._:-]+$/.test(id)) throw new AiProviderError("ID 格式无效", "INVALID_REQUEST");
  return id;
}

function buildModelMessages(
  stored: readonly { readonly role: "user" | "assistant"; readonly text: string; readonly status: "complete" | "partial" }[],
  contextBudgetTokens: number,
): readonly AiChatInputMessage[] {
  const system: AiChatInputMessage = {
    role: "system",
    content: "你是 Dayline 的 AI 助手。当前阶段只提供对话，不读取用户的邮件、日历、任务或笔记，也不能执行或声称已经执行任何操作。请使用用户所用的语言，给出清晰、诚实且简洁的回答。",
  };
  const maxCharacters = Math.min(160_000, Math.max(4_000, contextBudgetTokens * 4));
  const selected: AiChatInputMessage[] = [];
  let characters = system.content.length;
  for (let index = stored.length - 1; index >= 0; index -= 1) {
    const message = stored[index]!;
    if (!message.text || message.status === "partial") continue;
    if (characters + message.text.length > maxCharacters && selected.length) break;
    selected.unshift({ role: message.role, content: message.text.slice(0, maxCharacters - characters) });
    characters += message.text.length;
    if (characters >= maxCharacters) break;
  }
  return [system, ...selected];
}

function modelEvent(runId: string, routed: RoutedAiModel, usedFallback: boolean): CommandDataParts["model"] {
  return {
    runId,
    providerName: routed.provider.displayName,
    modelId: routed.model.id,
    modelName: routed.model.displayName,
    usedFallback,
  };
}

function fallbackEligible(error: unknown): boolean {
  const normalized = toAiPublicError(error);
  return normalized.status === 429 || normalized.status >= 500;
}
