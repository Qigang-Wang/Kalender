import { NextResponse } from "next/server";

import { EntityLinkRepositoryError } from "./entity-link-repository";
import { EntityLinkValidationError } from "./entity-link-validation";

export function entityLinkErrorResponse(error: unknown) {
  if (error instanceof EntityLinkRepositoryError || error instanceof EntityLinkValidationError) {
    return NextResponse.json({ ok: false, message: error.message }, { status: error.status });
  }
  console.error("Entity link operation failed", error);
  return NextResponse.json({ ok: false, message: "对象关联操作失败" }, { status: 500 });
}
