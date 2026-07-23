import { NextResponse } from "next/server";

import { TaskRepositoryError } from "./task-repository";
import { TaskValidationError } from "./task-validation";

export function taskErrorResponse(error: unknown) {
  if (error instanceof TaskValidationError || error instanceof TaskRepositoryError) {
    return NextResponse.json({ ok: false, message: error.message }, { status: error.status });
  }
  console.error("Task operation failed", error);
  return NextResponse.json({ ok: false, message: "任务操作失败" }, { status: 500 });
}
