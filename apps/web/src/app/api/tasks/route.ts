import { NextResponse } from "next/server";

import { taskErrorResponse } from "@/server/task-api";
import { listStoredTasks, saveStoredTask } from "@/server/task-repository";
import { parseTaskInput, type TaskRequestBody } from "@/server/task-validation";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const includeCompleted = new URL(request.url).searchParams.get("includeCompleted") === "true";
    return NextResponse.json({ ok: true, tasks: await listStoredTasks(includeCompleted) });
  } catch (error) {
    return taskErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null) as TaskRequestBody | null;
    const task = await saveStoredTask(parseTaskInput(body));
    return NextResponse.json({ ok: true, task }, { status: 201 });
  } catch (error) {
    return taskErrorResponse(error);
  }
}
