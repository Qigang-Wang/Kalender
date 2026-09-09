// Direct Node tests need the same React version that Next aliases for the web app.
import { register, registerHooks } from "node:module";
import { isMainThread } from "node:worker_threads";
const parentURL = new URL("../apps/web/package.json", import.meta.url).href;
export function resolve(specifier, context, nextResolve) {
  if (/^react(?:-dom)?(?:\/|$)/.test(specifier)) return nextResolve(specifier, { ...context, parentURL });
  return nextResolve(specifier, context);
}
if (isMainThread) {
  register(import.meta.url);
  registerHooks({ resolve });
}
