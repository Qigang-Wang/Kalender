import { NextResponse } from "next/server";

import { taskErrorResponse } from "@/server/task-api";
import {
  parseTaskScheduleInput,
  scheduleStoredTask,
  TaskScheduleConflictError,
  type TaskScheduleRequestBody,
} from "@/server/task-schedule";

export const runtime = "nodejs";

interface TaskScheduleRouteContext {
  readonly params: Promise<{ readonly taskId: string }>;
}

export async function POST(request: Request, context: TaskScheduleRouteContext) {
  const { taskId } = await context.params;
  try {
    const body = await request.json().catch(() => null) as TaskScheduleRequestBody | null;
    const result = await scheduleStoredTask(taskId, parseTaskScheduleInput(body));
    return NextResponse.json({ ok: true, ...result }, { status: 201 });
  } catch (error) {
    if (error instanceof TaskScheduleConflictError) {
      return NextResponse.json({ ok: false, message: error.message, conflicts: error.conflicts }, { status: error.status });
    }
    return taskErrorResponse(error);
  }
}
