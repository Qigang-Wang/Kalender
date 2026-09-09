import { isPublicPath } from "./proxy";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

assert(isPublicPath("/icon.svg"), "known static assets remain public");
assert(isPublicPath("/api/auth/login"), "authentication endpoints remain public");
assert(!isPublicPath("/api/messages/message.with-dot/body"), "dots do not bypass API authentication");
assert(!isPublicPath("/private/report.pdf"), "arbitrary dotted paths remain protected");

console.log("Proxy public-path tests passed");
