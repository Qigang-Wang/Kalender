"use client";

import { AlertCircle, CheckCircle2, Circle, X } from "lucide-react";
import { useEffect, useRef, type CSSProperties } from "react";

type TransientToastKind = "success" | "error" | "info";

function inferTransientToastKind(message: string): TransientToastKind {
  if (/无法|失败|错误|冲突|不能|找不到|不存在|已删除或|请先|请至少|请输入|必须晚于|尚未准备好|没有可写/.test(message)) return "error";
  if (/^(已|任务已|日程已|项目已|下一步行动已|里程碑已|阶段已|笔记已|关联任务已|邮件已|附件已|草稿已|AI 已)/.test(message)) return "success";
  return "info";
}

export function TransientToast({
  message,
  onClose,
  duration = 3_000,
  testId,
}: {
  readonly message: string;
  readonly onClose: () => void;
  readonly duration?: number;
  readonly testId?: string;
}) {
  const onCloseRef = useRef(onClose);
  const kind = inferTransientToastKind(message);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const timer = window.setTimeout(() => onCloseRef.current(), duration);
    return () => window.clearTimeout(timer);
  }, [duration, message]);

  return <div
    className={`app-toast ${kind}`}
    data-testid={testId}
    key={message}
    role={kind === "error" ? "alert" : "status"}
    aria-live={kind === "error" ? "assertive" : "polite"}
    style={{ "--toast-duration": `${duration}ms` } as CSSProperties}
  >
    {kind === "success" ? <CheckCircle2 size={16} /> : kind === "error" ? <AlertCircle size={16} /> : <Circle size={14} />}
    <span>{message}</span>
    <button type="button" aria-label="关闭提示" onClick={onClose}><X size={13} /></button>
  </div>;
}
