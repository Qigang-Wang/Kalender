import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function main() {
  const testRoot = path.join(tmpdir(), `kalender-ai-provider-test-${randomUUID()}`);
  process.env.KALENDER_DATA_DIR = testRoot;
  const repository = await import("./ai-provider-repository");
  const validation = await import("./ai-provider-validation");
  const adapter = await import("./openai-compatible-ai");
  const backupService = await import("./backup-service");
  const { closeDatabaseForRestore, getDatabase } = await import("./database");
  const requests: Array<{ readonly url: string; readonly authorization?: string }> = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url ?? "", authorization: request.headers.authorization });
    if (request.headers.authorization !== "Bearer stage-a-secret") {
      response.writeHead(401).end();
      return;
    }
    if (request.method === "GET" && request.url === "/v1/models") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ data: [
        { id: "gpt-oss-120b", owned_by: "test" },
        { id: "mistral-small-4-119b-2603", owned_by: "test" },
      ] }));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/chat/completions") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        if (body.stream === true) {
          response.writeHead(200, { "Content-Type": "text/event-stream" });
          response.end("data: {\"choices\":[{\"delta\":{\"content\":\"OK\"}}]}\n\ndata: [DONE]\n\n");
          return;
        }
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(Array.isArray(body.tools)
          ? { choices: [{ message: { tool_calls: [{ id: "1", type: "function", function: { name: "health_check", arguments: "{}" } }] } }] }
          : { choices: [{ message: { content: "OK" } }] }));
      });
      return;
    }
    response.writeHead(404).end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert(address && typeof address === "object", "test server has an address");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;

  try {
    const secret = "stage-a-secret";
    const providerInput = validation.parseAiProviderInput({
      displayName: "Local OpenAI Test",
      baseUrl,
      apiKey: secret,
      providerKind: "openai-compatible",
      allowPrivateNetwork: true,
    });
    const connection = await adapter.testAiProviderConnection(providerInput, { apiKey: secret });
    assert(connection.models.length === 2, "provider model discovery works");
    assert(connection.models[0]?.apiModelId === "gpt-oss-120b", "model id is preserved");

    const provider = await repository.saveAiProvider(providerInput);
    assert(provider.hasApiKey, "public provider reports a stored key");
    assert(!("apiKey" in provider), "public provider never contains the API key");
    assert((await repository.loadAiProviderCredential(provider.id)).apiKey === secret, "encrypted API key round trip");

    const database = await getDatabase();
    const encrypted = await database.query<{ encrypted_payload: string }>(
      "SELECT encrypted_payload FROM ai_provider_credentials WHERE provider_id = $1", [provider.id],
    );
    assert(!encrypted.rows[0]?.encrypted_payload.includes(secret), "API key is not stored in plaintext");

    const modelInput = validation.parseAiModelInput({
      apiModelId: "gpt-oss-120b",
      displayName: "GPT OSS 120b",
      modelKind: "chat",
      endpointKind: "chat-completions",
      contextWindow: 131_072,
      maxOutputTokens: 8_192,
      dataRegion: "Germany",
    }, provider.id);
    const capabilityTest = await adapter.testAiModelCapabilities(providerInput, { apiKey: secret }, modelInput);
    assert(capabilityTest.capabilities.streaming, "streaming capability is detected");
    assert(capabilityTest.capabilities.functionCalling, "tool calling capability is detected");
    const model = await repository.saveAiModel(modelInput, capabilityTest);
    assert(model.lastTestStatus === "passed", "tested model is stored as passed");
    assert(model.capabilities.functionCalling, "tested capabilities are stored");

    const binding = await repository.saveAiFeatureBinding(validation.parseAiFeatureBindingInput({
      featureKey: "mail.draft_reply",
      primaryModelId: model.id,
      contextBudgetTokens: 24_000,
      timeoutMs: 45_000,
      toolMode: "write-proposals",
    }));
    assert(binding.primaryModelId === model.id, "feature binding stores primary model");
    assert((await repository.listAiFeatureBindings()).length === validation.aiFeatureKeys.length, "all stable feature keys are returned");

    let backupFailure: unknown;
    try {
      await backupService.exportWorkspaceBackup();
    } catch (error) {
      backupFailure = error;
    }
    assert(
      backupFailure instanceof backupService.BackupError && backupFailure.status === 404,
      "backup export requires an existing backup artifact",
    );

    await repository.saveAiProvider(validation.parseAiProviderInput({
      providerId: provider.id,
      displayName: "Local OpenAI Updated",
      baseUrl,
      allowPrivateNetwork: true,
    }));
    assert((await repository.loadAiProviderCredential(provider.id)).apiKey === secret, "blank key retains encrypted credential");
    assert(requests.every((item) => item.authorization === "Bearer stage-a-secret"), "tests use the configured bearer token");

    const replacementSecret = `replacement-${randomUUID()}`;
    await repository.saveAiProvider(validation.parseAiProviderInput({
      providerId: provider.id,
      displayName: "Local OpenAI Updated",
      baseUrl,
      apiKey: replacementSecret,
      allowPrivateNetwork: true,
    }));
    assert((await repository.loadAiProviderCredential(provider.id)).apiKey === replacementSecret, "new key replaces the encrypted credential");
    const replaced = await database.query<{ encrypted_payload: string }>(
      "SELECT encrypted_payload FROM ai_provider_credentials WHERE provider_id = $1", [provider.id],
    );
    assert(!replaced.rows[0]?.encrypted_payload.includes(replacementSecret), "replacement key is not stored in plaintext");

    assert(await repository.deleteAiProvider(provider.id), "provider can be deleted");
    assert((await repository.listAiModels()).length === 0, "provider deletion cascades to models");
    const cleared = (await repository.listAiFeatureBindings()).find((item) => item.featureKey === "mail.draft_reply");
    assert(!cleared?.primaryModelId, "provider deletion clears feature bindings");
    console.log("AI provider storage, encryption, discovery and capability tests passed");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeDatabaseForRestore().catch(() => undefined);
    await rm(testRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
