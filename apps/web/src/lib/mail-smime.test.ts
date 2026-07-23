import assert from "node:assert/strict";

import { isSmimeSignatureAttachment } from "./mail-smime";

assert.equal(isSmimeSignatureAttachment({ filename: "smime.p7m", contentType: "multipart/signed" }), true);
assert.equal(isSmimeSignatureAttachment({ filename: "smime.p7s", contentType: "application/pkcs7-signature" }), true);
assert.equal(isSmimeSignatureAttachment({ filename: "signature.p7s", contentType: "application/octet-stream" }), true);
assert.equal(isSmimeSignatureAttachment({ filename: "smime.p7m", contentType: "application/pkcs7-mime; smime-type=enveloped-data" }), false);
assert.equal(isSmimeSignatureAttachment({ filename: "contract.pdf", contentType: "application/pdf" }), false);

console.log("S/MIME attachment detection tests passed");
