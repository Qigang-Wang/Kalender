export function buildMailIframeDocument(html: string, allowRemoteImages: boolean): string {
  const imageSources = allowRemoteImages ? "'self' data: http: https:" : "'self' data:";
  const policy = `default-src 'none'; script-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; media-src 'none'; font-src 'none'; form-action 'none'; base-uri 'none'; style-src 'unsafe-inline'; img-src ${imageSources}`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="color-scheme" content="light"><style>html{color-scheme:light}body{margin:0;padding:18px;color:#202124;background:#fff;font:14px/1.5 Arial,sans-serif;overflow-wrap:break-word}img{max-width:100%;height:auto}table{max-width:100%}pre{max-width:100%;overflow:auto;white-space:pre-wrap}</style></head><body>${html}</body></html>`;
}
