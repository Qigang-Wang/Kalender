import { buildMailAiMessages } from "./mail-ai-service";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

const mail = {
  subject: "Meeting",
  senderName: "Anna",
  senderAddress: "anna@example.test",
  to: ["adam@example.test"],
  receivedAt: "2026-07-22T10:00:00.000Z",
  text: "Can we meet on Tuesday?",
};

const instructed = buildMailAiMessages("draft-reply", mail, "同意参加，但希望改到周三下午。");
assert(instructed[0]?.role === "system" && instructed[0].content.includes("回复要求由用户主动提供"), "system prompt distinguishes user requirements from untrusted mail");
assert(instructed[1]?.content.includes("<reply_requirements>\n同意参加，但希望改到周三下午。\n</reply_requirements>"), "reply requirements are passed in a dedicated boundary");
assert(instructed[1]?.content.includes("严格结合用户提供的回复要求"), "draft prompt tells the model to follow the requirements");

const direct = buildMailAiMessages("draft-reply", mail);
assert(!direct[1]?.content.includes("<reply_requirements>"), "empty editor generates a direct reply without a requirements block");

console.log("Mail AI prompt tests passed");
