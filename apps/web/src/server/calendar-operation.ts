import { createHash } from "node:crypto";
import { getCurrentAppUser } from "./auth";
import { getDatabase } from "./database";

/** An interrupted remote write must never be blindly replayed (meeting notifications). */
export async function runCalendarOperation(request: Request, operation: (beginWrite: () => Promise<void>) => Promise<Response>): Promise<Response> {
  const id = request.headers.get("x-calendar-operation-id");
  if (!id) return operation(async () => {});
  if (!/^[a-zA-Z0-9-]{8,100}$/.test(id)) return Response.json({ message: "操作标识无效" }, { status: 400 });
  const user = await getCurrentAppUser();
  if (!user) return Response.json({ message: "请先登录" }, { status: 401 });
  const hash = createHash("sha256").update(`${request.method}\n${new URL(request.url).pathname}${new URL(request.url).search}\n${await request.clone().text()}`).digest("hex");
  const database = await getDatabase();
  const claim = await database.query(`INSERT INTO calendar_operation_receipts (user_id, operation_id, request_hash) VALUES ($1,$2,$3) ON CONFLICT (user_id, operation_id) DO UPDATE SET response_body = NULL, response_status = NULL
    WHERE calendar_operation_receipts.request_hash = EXCLUDED.request_hash
      AND calendar_operation_receipts.write_started = false
      AND calendar_operation_receipts.response_status >= 400
    RETURNING operation_id`, [user.id, id, hash]);
  if (!claim.rows.length) {
    const receipt = (await database.query<{ request_hash: string; response_body: string | null; response_status: number | null }>("SELECT * FROM calendar_operation_receipts WHERE user_id = $1 AND operation_id = $2", [user.id, id])).rows[0];
    if (receipt?.request_hash !== hash) return Response.json({ message: "同一操作标识不能用于不同修改" }, { status: 409 });
    if (!receipt.response_status) return Response.json({ message: "此操作仍在处理或结果尚未确认，请同步日历核对，勿重复发送通知" }, { status: 409 });
    return new Response(receipt.response_body, { status: receipt.response_status, headers: { "Content-Type": "application/json" } });
  }
  const response = await operation(async () => {
    await database.query("UPDATE calendar_operation_receipts SET write_started = true WHERE user_id = $1 AND operation_id = $2", [user.id, id]);
  });
  await database.query("UPDATE calendar_operation_receipts SET response_body = $3, response_status = $4 WHERE user_id = $1 AND operation_id = $2", [user.id, id, await response.clone().text(), response.status]);
  return response;
}
