import {
  resolveCidImages,
  resolveExchangeInlineImages,
  sanitizeEmailHtml,
  shouldUseMailBodyCache,
} from "./mail-body-service";
import { MAIL_BODY_CACHE_VERSION } from "./mail-repository";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

const sanitized = sanitizeEmailHtml(`
  <div onclick="steal()" style="color:#123456; background-image:url(https://tracker.example/bg.gif); position:fixed; padding:12px">
    <script>alert('xss')</script>
    <style>body { display: none }</style>
    <p>保留的正文 <strong>重点</strong></p>
    <img src="https://tracker.example/pixel.gif" onerror="steal()">
    <img src="javascript:steal()">
    <a href="javascript:steal()">危险链接</a>
    <a href="https://example.test/path" style="color:red">安全链接</a>
    <form action="https://evil.example"><input name="password"></form>
  </div>
`);

assert(sanitized.includes("保留的正文"), "message content is retained");
assert(sanitized.includes("<strong>重点</strong>"), "safe formatting is retained");
assert(sanitized.includes('href="https://example.test/path"'), "safe HTTPS links are retained");
assert(sanitized.includes('target="_blank"'), "links open outside the application");
assert(sanitized.includes('rel="noopener noreferrer"'), "external links cannot control the opener");
assert(sanitized.includes("color:#123456"), "safe email colors are retained");
assert(sanitized.includes("padding:12px"), "safe email spacing is retained");
assert(sanitized.includes('data-remote-src="https://tracker.example/pixel.gif"'), "remote images are retained in a blocked state");
assert(!/<img\b[^>]*\ssrc="https:\/\/tracker\.example\/pixel\.gif"/i.test(sanitized), "remote images do not load before user approval");
assert(!sanitized.includes("script"), "scripts are removed");
assert(!sanitized.includes("display: none"), "style blocks are removed");
assert(!sanitized.includes("onclick"), "event handlers are removed");
assert(!sanitized.includes("background-image"), "CSS image tracking is removed");
assert(!sanitized.includes("position"), "email CSS cannot escape its container");
assert(!sanitized.includes("onerror"), "image event handlers are removed");
assert(!sanitized.includes("javascript:"), "dangerous URL schemes are removed");
assert(!sanitized.includes("<form"), "interactive forms are removed");

const cidResolved = resolveCidImages('<p>Logo</p><img src="cid:logo@example.test">', [{
  filename: "logo.png",
  mimeType: "image/png",
  disposition: "inline",
  related: true,
  contentId: "<logo@example.test>",
  content: new Uint8Array([137, 80, 78, 71]),
}]);
const cidSanitized = sanitizeEmailHtml(cidResolved);
assert(cidSanitized.includes('src="data:image/png;base64,iVBORw=="'), "CID images are embedded without a remote request");
assert(!cidSanitized.includes("cid:"), "resolved CID references are removed");

const exchangeCidResolved = resolveExchangeInlineImages('<p>Exchange logo</p><img src="cid:logo@exchange.test">', [{
  id: "attachment-1",
  filename: "logo.png",
  contentType: "image/png",
  sizeBytes: 1024,
  inline: true,
  contentId: "<logo@exchange.test>",
}], "exchange-message:test-id");
const exchangeCidSanitized = sanitizeEmailHtml(exchangeCidResolved);
assert(
  exchangeCidSanitized.includes('src="/api/messages/exchange-message%3Atest-id/attachments/0"'),
  "Exchange CID images use the authenticated local attachment endpoint",
);
assert(!exchangeCidSanitized.includes("cid:"), "Exchange CID references are removed");
assert(
  !sanitizeEmailHtml('<img src="/api/messages/../../secrets/attachments/0">').includes("src="),
  "untrusted local image paths are removed",
);
const cacheNow = Date.parse("2026-07-23T12:00:00.000Z");
const cacheMaxAge = 24 * 60 * 60 * 1000;
assert(
  shouldUseMailBodyCache("2026-07-23T08:00:00.000Z", MAIL_BODY_CACHE_VERSION, false, cacheNow, cacheMaxAge),
  "current body cache is reused",
);
assert(
  !shouldUseMailBodyCache("2026-07-23T08:00:00.000Z", MAIL_BODY_CACHE_VERSION, true, cacheNow, cacheMaxAge),
  "manual refresh bypasses current body cache",
);
assert(!shouldUseMailBodyCache(undefined, MAIL_BODY_CACHE_VERSION, false, cacheNow, cacheMaxAge), "missing body cache is fetched");
assert(
  !shouldUseMailBodyCache("2026-07-23T08:00:00.000Z", MAIL_BODY_CACHE_VERSION - 1, false, cacheNow, cacheMaxAge),
  "outdated sanitizer cache is fetched again",
);
assert(
  !shouldUseMailBodyCache("2026-07-22T11:59:59.999Z", MAIL_BODY_CACHE_VERSION, false, cacheNow, cacheMaxAge),
  "expired body cache is fetched again",
);

console.log("Mail body sanitizer tests passed");
