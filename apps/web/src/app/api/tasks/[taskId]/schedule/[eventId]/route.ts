import { NextResponse } from "next/server";

import { taskErrorResponse } from "@/server/task-api";
import {
  deleteStoredTaskSchedule,
  parseTaskScheduleInput,
  TaskScheduleConflictError,
  updateStoredTaskSchedule,
  type TaskScheduleRequestBody,
} from "@/server/task-schedule";

export const runtime = "nodejs";

interface TaskScheduleEventRouteContext {
  readonly params: Promise<{ readonly taskId: string; readonly eventId: string }>;
}

export async function PATCH(request: Request, context: TaskScheduleEventRouteContext) {
  const { taskId, eventId } = await context.params;
  try {
    const body = await request.json().catch(() => null) as TaskScheduleRequestBody | null;
    const result = await updateStoredTaskSchedule(taskId, eventId, parseTaskScheduleInput(body));
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof TaskScheduleConflictError) {
      return NextResponse.json({ ok: false, message: error.message, conflicts: error.conflicts }, { status: error.status });
    }
    return taskErrorResponse(error);
  }
}

export async function DELETE(_request: Request, context: TaskScheduleEventRouteContext) {
  const { taskId, eventId } = await context.params;
  try {
    const task = await deleteStoredTaskSchedule(taskId, eventId);
    return NextResponse.json({ ok: true, task });
  } catch (error) {
    return taskErrorResponse(error);
  }
}
