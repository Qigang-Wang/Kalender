import assert from "node:assert/strict";

import { resolveReplyRecipients } from "./mail-reply-recipients";

const replyAll = resolveReplyRecipients({
  senderAddress: "sender@example.com",
  to: [
    { address: "me@example.com" },
    { address: "colleague@example.com" },
  ],
  cc: [
    { address: "ME@example.com" },
    { address: "observer@example.com" },
    { address: "COLLEAGUE@example.com" },
  ],
  selfAddresses: ["me@example.com", "login@example.com"],
});
assert.deepEqual(replyAll, {
  to: ["sender@example.com", "colleague@example.com"],
  cc: ["observer@example.com"],
});

const replyToSentMessage = resolveReplyRecipients({
  senderAddress: "alias@example.com",
  to: [{ address: "recipient@example.com" }],
  cc: [{ address: "copy@example.com" }],
  selfAddresses: ["alias@example.com"],
});
assert.deepEqual(replyToSentMessage, {
  to: ["recipient@example.com"],
  cc: ["copy@example.com"],
});

const rwthAliasReply = resolveReplyRecipients({
  senderAddress: "ukarakoc@amt.rwth-aachen.de",
  to: [
    { address: "ukarakoc@amt.rwth-aachen.de" },
    { address: "qwang@amt.rwth-aachen.de" },
  ],
  cc: [{ address: "observer@amt.rwth-aachen.de" }],
  selfAddresses: [
    "qigangw@amt.rwth-aachen.de",
    "qwang@amt.rwth-aachen.de",
  ],
});
assert.deepEqual(rwthAliasReply, {
  to: ["ukarakoc@amt.rwth-aachen.de"],
  cc: ["observer@amt.rwth-aachen.de"],
});

console.log("Mail reply recipient tests passed");
