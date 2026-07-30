import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function main() {
  const testRoot = path.join(tmpdir(), `kalender-ai-chat-test-${randomUUID()}`);
  process.env.KALENDER_DATA_DIR = testRoot;
  const repository = await import("./ai-provider-repository");
  const validation = await import("./ai-provider-validation");
  const chatRepository = await import("./ai-chat-repository");
  const { closeDatabaseForRestore, getDatabase } = await import("./database");
  const { POST } = await import("../app/api/ai/chat/route");
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      if (request.headers.authorization !== "Bearer chat-test-secret") {
        response.writeHead(401).end();
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model?: string; messages?: Array<{ content?: string }> };
      const forceFallback = body.messages?.some((message) => message.content?.includes("force fallback"));
      if (body.model === "primary-model" && forceFallback) {
        response.writeHead(503, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "temporary" }));
        return;
      }
      const answer = body.model === "fallback-model" ? "Fallback works." : "Primary works.";
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(`data: {"choices":[{"delta":{"content":"${answer.slice(0, 8)}"}}]}\n\n`);
      response.end(`data: {"choices":[{"delta":{"content":"${answer.slice(8)}"}}],"usage":{"prompt_tokens":10,"completion_tokens":3}}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object", "mock server has an address");

  try {
    const provider = await repository.saveAiProvider(validation.parseAiProviderInput({
      displayName: "Chat Test Provider",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: "chat-test-secret",
      allowPrivateNetwork: true,
    }));
    const primary = await repository.saveAiModel(validation.parseAiModelInput({
      apiModelId: "primary-model",
      displayName: "Primary",
      modelKind: "chat",
      endpointKind: "chat-completions",
    }, provider.id));
    const fallback = await repository.saveAiModel(validation.parseAiModelInput({
      apiModelId: "fallback-model",
      displayName: "Fallback",
      modelKind: "chat",
      endpointKind: "chat-completions",
    }, provider.id));
    await repository.saveAiFeatureBinding(validation.parseAiFeatureBindingInput({
      featureKey: "assistant.default",
      primaryModelId: primary.id,
      fallbackModelId: fallback.id,
      contextBudgetTokens: 8_000,
      timeoutMs: 30_000,
    }));

    const first = await POST(chatRequest("user-one", "hello"));
    assert(first.ok, "primary chat route returns a stream response");
    const firstStream = await first.text();
    assert(firstStream.includes("Primary ") && firstStream.includes("works."), "primary response streams through UI message protocol");
    assert(firstStream.includes("data-conversation"), "stream announces the persisted conversation");
    assert(firstStream.includes("data-model"), "stream announces the active model");

    const conversations = await chatRepository.listAiConversations();
    assert(conversations.length === 1, "new chat creates one conversation");
    const messages = await chatRepository.listAiChatMessages(conversations[0]!.id);
    assert(messages.length === 2, "successful chat persists user and assistant messages");
    assert(messages[1]?.text === "Primary works.", "assistant text is persisted exactly");

    const second = await POST(chatRequest("user-two", "force fallback"));
    const secondStream = await second.text();
    assert(secondStream.includes("data-fallback"), "primary pre-token failure emits fallback status");
    assert(secondStream.includes("Fallback") && secondStream.includes(" works."), "fallback model response is streamed");
    const database = await getDatabase();
    const runs = await database.query<{ status: string; attempt_count: number; used_fallback: boolean }>(
      "SELECT status, attempt_count, used_fallback FROM ai_runs ORDER BY created_at",
    );
    assert(runs.rows.length === 2 && runs.rows.every((run) => run.status === "succeeded"), "both runs finish successfully");
    assert(runs.rows[1]?.attempt_count === 2 && runs.rows[1]?.used_fallback, "fallback run records exactly two attempts");

    const backupService = await import("./backup-service");
    let backupFailure: unknown;
    try {
      await backupService.exportWorkspaceBackup();
    } catch (error) {
      backupFailure = error;
    }
    assert(
      backupFailure instanceof backupService.BackupError && backupFailure.status === 404,
      "backup export requires an artifact created by the PostgreSQL backup job",
    );
    console.log("AI chat streaming, persistence and fallback tests passed");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeDatabaseForRestore().catch(() => undefined);
    await rm(testRoot, { recursive: true, force: true });
  }
}

function chatRequest(id: string, text: string): Request {
  return new Request("http://localhost/api/ai/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ id, role: "user", parts: [{ type: "text", text }] }] }),
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
