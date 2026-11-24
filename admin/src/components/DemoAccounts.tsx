import { useEffect, useState } from "react";
import { demoApi, type DemoAccount } from "../api/demo";
import type { AuthResponse } from "../types";
import Button from "./ui/Button";
import { useConsolePreferences } from "./useConsolePreferences";

export default function DemoAccounts({
  onLogin,
  disabled,
}: {
  onLogin: (response: AuthResponse) => void;
  disabled: boolean;
}) {
  const { language } = useConsolePreferences(),
    ka = language === "ka";
  const [accounts, setAccounts] = useState<DemoAccount[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    if (import.meta.env.DEV)
      void demoApi
        .accounts()
        .then((r) => {
          if (live && r.enabled) setAccounts(r.accounts);
        })
        .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  if (!accounts.length) return null;
  async function login(id: string) {
    if (busy || disabled) return;
    setBusy(true);
    setError("");
    try {
      onLogin(await demoApi.login(id));
    } catch {
      setError(
        ka
          ? "შესვლა ვერ შესრულდა. სცადე ხელახლა."
          : "Sign-in failed. Please retry.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="demo-accounts" aria-labelledby="demo-login-title">
      <h3 id="demo-login-title">
        {ka ? "სწრაფი შესვლა · ვებ-დემო" : "Quick sign-in · Web demo"}
      </h3>
      <p>
        {ka
          ? `${accounts.length} სატესტო ანგარიში. უფლებები სერვერზე მოწმდება.`
          : `${accounts.length} synthetic accounts with server-enforced permissions.`}
      </p>
      {error && <p role="alert">{error}</p>}
      <div className="demo-account-grid">
        {accounts.map((a) => (
          <Button
            type="button"
            key={a.id}
            variant="secondary"
            disabled={disabled || busy}
            onClick={() => void login(a.id)}
          >
            <span>
              {a.kind === "technical"
                ? a.email === "platform-reviewer@ertad.local"
                  ? ka
                    ? "ტექნიკური მიმომხილველი"
                    : "Technical reviewer"
                  : ka
                    ? "ტექნიკური ადმინისტრატორი"
                    : "Technical administrator"
                : a.label}
              <small>{a.email}</small>
            </span>
          </Button>
        ))}
      </div>
    </section>
  );
}
