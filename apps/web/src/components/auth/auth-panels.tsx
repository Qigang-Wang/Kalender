"use client";

import { Eye, EyeOff, LoaderCircle, LockKeyhole, ShieldCheck, UserRound } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";

import { BrandLogo } from "@/components/brand-logo";

type AuthMode = "login" | "setup";

interface AuthPanelProps {
  readonly mode: AuthMode;
}

export function ChangePasswordPanel({ displayName }: { readonly displayName: string }) {
  const router = useRouter();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string>();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      setFeedback("两次输入的新密码不一致");
      return;
    }
    setBusy(true);
    setFeedback(undefined);
    try {
      const response = await fetch("/api/users/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName, currentPassword, newPassword }),
      });
      const payload = await response.json().catch(() => null) as { readonly message?: string } | null;
      if (!response.ok) throw new Error(payload?.message || "无法修改密码");
      router.replace("/today");
      router.refresh();
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法修改密码");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-screen">
      <section className="auth-brand">
        <BrandLogo className="auth-brand-mark" />
        <div><strong>Dayline</strong><span>Quiet Intelligence</span></div>
      </section>
      <section className="auth-panel" aria-labelledby="change-password-title">
        <header>
          <div className="auth-panel-icon"><LockKeyhole size={19} /></div>
          <h1 id="change-password-title">先修改初始密码</h1>
          <p>管理员为你创建了账号。进入工作台前，请把临时密码换成只有你知道的新密码。</p>
        </header>
        <form className="auth-form" onSubmit={(event) => void submit(event)}>
          <label><span>当前密码</span><div className="auth-input"><LockKeyhole size={16} /><input autoComplete="current-password" type={showPassword ? "text" : "password"} value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required /><button type="button" aria-label={showPassword ? "隐藏密码" : "显示密码"} onClick={() => setShowPassword((value) => !value)}>{showPassword ? <EyeOff size={15} /> : <Eye size={15} />}</button></div></label>
          <label><span>新密码</span><div className="auth-input"><LockKeyhole size={16} /><input autoComplete="new-password" type={showPassword ? "text" : "password"} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder="至少 8 个字符" required /></div></label>
          <label><span>确认新密码</span><div className="auth-input"><LockKeyhole size={16} /><input autoComplete="new-password" type={showPassword ? "text" : "password"} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required /></div></label>
          {feedback && <div className="auth-feedback" role="alert">{feedback}</div>}
          <button className="auth-submit" type="submit" disabled={busy || newPassword.length < 8}>{busy ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}{busy ? "正在保存…" : "保存并进入工作台"}</button>
        </form>
      </section>
    </main>
  );
}

export function InviteAcceptPanel({
  token,
  email,
  suggestedName,
}: {
  readonly token: string;
  readonly email: string;
  readonly suggestedName: string;
}) {
  const router = useRouter();
  const [displayName, setDisplayName] = useState(suggestedName);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string>();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setFeedback(undefined);
    try {
      const response = await fetch("/api/auth/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, displayName, username, password, confirmPassword }),
      });
      const payload = await response.json().catch(() => null) as { readonly message?: string } | null;
      if (!response.ok) throw new Error(payload?.message || "无法接受邀请");
      router.replace("/today");
      router.refresh();
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法接受邀请");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-screen">
      <section className="auth-brand">
        <BrandLogo className="auth-brand-mark" />
        <div><strong>Dayline</strong><span>Quiet Intelligence</span></div>
      </section>
      <section className="auth-panel" aria-labelledby="invite-title">
        <header>
          <div className="auth-panel-icon"><UserRound size={19} /></div>
          <h1 id="invite-title">接受工作台邀请</h1>
          <p>{email} 已被邀请加入这个工作台。设置密码后即可进入你的空间。</p>
        </header>
        <form className="auth-form" onSubmit={(event) => void submit(event)}>
          <label><span>昵称</span><div className="auth-input"><UserRound size={16} /><input autoComplete="name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} required /></div></label>
          <label><span>用户名</span><div className="auth-input"><UserRound size={16} /><input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} placeholder="用于登录" required /></div></label>
          <label><span>密码</span><div className="auth-input"><LockKeyhole size={16} /><input autoComplete="new-password" type={showPassword ? "text" : "password"} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="至少 8 个字符" required /><button type="button" aria-label={showPassword ? "隐藏密码" : "显示密码"} onClick={() => setShowPassword((value) => !value)}>{showPassword ? <EyeOff size={15} /> : <Eye size={15} />}</button></div></label>
          <label><span>确认密码</span><div className="auth-input"><LockKeyhole size={16} /><input autoComplete="new-password" type={showPassword ? "text" : "password"} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required /></div></label>
          {feedback && <div className="auth-feedback" role="alert">{feedback}</div>}
          <button className="auth-submit" type="submit" disabled={busy || displayName.trim().length < 2 || username.trim().length < 3 || password.length < 8}>{busy ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}{busy ? "正在加入…" : "加入工作台"}</button>
        </form>
      </section>
    </main>
  );
}

export function AuthPanel({ mode }: AuthPanelProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string>();
  const nextPath = useMemo(() => safeNextPath(searchParams.get("next")), [searchParams]);
  const isSetup = mode === "setup";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setFeedback(undefined);
    try {
      const response = await fetch(isSetup ? "/api/auth/setup" : "/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(isSetup ? { displayName, username, password, confirmPassword } : { username, password, remember }),
      });
      const payload = await response.json().catch(() => null) as { readonly message?: string } | null;
      if (!response.ok) throw new Error(payload?.message || (isSetup ? "初始化失败" : "登录失败"));
      router.replace(nextPath);
      router.refresh();
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : (isSetup ? "初始化失败" : "登录失败"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-screen">
      <section className="auth-brand">
        <BrandLogo className="auth-brand-mark" />
        <div>
          <strong>Dayline</strong>
          <span>Quiet Intelligence</span>
        </div>
      </section>

      <section className="auth-panel" aria-labelledby="auth-title">
        <header>
          <div className="auth-panel-icon"><LockKeyhole size={19} /></div>
          <h1 id="auth-title">{isSetup ? "创建管理员账号" : "登录你的工作台"}</h1>
          <p>{isSetup ? "先保护工作台，进入后再连接邮箱、日历和 AI 服务。" : "使用工作台账号进入你的邮件、日历、任务和笔记空间。"}</p>
        </header>

        <form className="auth-form" onSubmit={(event) => void submit(event)}>
          {isSetup && (
            <label>
              <span>昵称</span>
              <div className="auth-input">
                <UserRound size={16} />
                <input
                  autoComplete="name"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder="你的名字"
                  required
                />
              </div>
            </label>
          )}

          <label>
            <span>用户名</span>
            <div className="auth-input">
              <UserRound size={16} />
              <input
                autoComplete="username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="输入用户名"
                required
              />
            </div>
          </label>

          <label>
            <span>密码</span>
            <div className="auth-input">
              <LockKeyhole size={16} />
              <input
                autoComplete={isSetup ? "new-password" : "current-password"}
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={isSetup ? "至少 8 个字符" : "输入密码"}
                required
              />
              <button type="button" aria-label={showPassword ? "隐藏密码" : "显示密码"} onClick={() => setShowPassword((value) => !value)}>
                {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </label>

          {isSetup && (
            <label>
              <span>确认密码</span>
              <div className="auth-input">
                <LockKeyhole size={16} />
                <input
                  autoComplete="new-password"
                  type={showPassword ? "text" : "password"}
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  placeholder="再次输入密码"
                  required
                />
              </div>
            </label>
          )}

          {feedback && <div className="auth-feedback" role="alert">{feedback}</div>}

          {!isSetup && (
            <label className="auth-remember">
              <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
              <span>保持登录 30 天</span>
            </label>
          )}

          <button className="auth-submit" type="submit" disabled={busy}>
            {busy ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}
            {isSetup ? "创建并进入工作台" : "登录"}
          </button>
        </form>
      </section>

      <aside className="auth-context" aria-label="登录说明">
        <div><strong>本地账号优先</strong><span>进入工作台后再配置邮箱、日历和 AI Provider。</span></div>
        <div><strong>默认私有</strong><span>没有管理员账号前才允许初始化；之后不开放公开注册。</span></div>
        <div><strong>清晰授权</strong><span>外部服务连接和写入操作继续由用户确认。</span></div>
      </aside>
    </main>
  );
}

function safeNextPath(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/today";
  if (value.startsWith("/login") || value.startsWith("/setup")) return "/today";
  return value;
}
