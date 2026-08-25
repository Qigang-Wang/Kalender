import { NextResponse } from "next/server";

import { taskErrorResponse } from "@/server/task-api";
import { deleteStoredTask, getStoredTask, saveStoredTask, TaskRepositoryError } from "@/server/task-repository";
import { parseTaskInput, type TaskRequestBody } from "@/server/task-validation";

export const runtime = "nodejs";

interface TaskRouteContext {
  readonly params: Promise<{ readonly taskId: string }>;
}

export async function GET(_request: Request, context: TaskRouteContext) {
  const { taskId } = await context.params;
  try {
    const task = await getStoredTask(taskId);
    if (!task) throw new TaskRepositoryError("TASK_NOT_FOUND", "Aufgabe existiert nicht", 404);
    return NextResponse.json({ ok: true, task });
  } catch (error) {
    return taskErrorResponse(error);
  }
}

export async function PATCH(request: Request, context: TaskRouteContext) {
  const { taskId } = await context.params;
  try {
    const body = await request.json().catch(() => null) as TaskRequestBody | null;
    return NextResponse.json({ ok: true, task: await saveStoredTask(parseTaskInput(body, taskId)) });
  } catch (error) {
    return taskErrorResponse(error);
  }
}

export async function DELETE(_request: Request, context: TaskRouteContext) {
  const { taskId } = await context.params;
  try {
    if (!await deleteStoredTask(taskId)) throw new TaskRepositoryError("TASK_NOT_FOUND", "Aufgabe existiert nicht", 404);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return taskErrorResponse(error);
  }
}
