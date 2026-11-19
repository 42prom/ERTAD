import { useEffect, useRef, useState, type FormEvent } from "react";
import { invitationsApi } from "../api/invitations";
import { recoveryApi } from "../api/recovery";
import { apiErrorStatus } from "../api/errors";
import { useConsolePreferences } from "../components/useConsolePreferences";
import Card from "../components/ui/Card";
import Input from "../components/ui/Input";
import Button from "../components/ui/Button";

export default function ActivateAccount({
  recovery = false,
}: {
  recovery?: boolean;
}) {
  const { language } = useConsolePreferences(),
    t = (ka: string, en: string) => (language === "ka" ? ka : en);
  const [credential, setCredential] = useState(() => {
    const match =
      /^#([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/i.exec(
        window.location.hash,
      );
    return match ? { id: match[1], token: match[2] } : null;
  });
  useEffect(() => {
    window.history.replaceState(
      window.history.state,
      "",
      window.location.pathname,
    );
  }, []);
  const [password, setPassword] = useState(""),
    [repeat, setRepeat] = useState(""),
    [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false),
    [outcome, setOutcome] = useState<"done" | "uncertain" | null>(null),
    [error, setError] = useState("");
  const lock = useRef(false);
  const valid =
    password.length >= 14 &&
    new TextEncoder().encode(password).length <= 72 &&
    password === repeat;
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (lock.current || !credential || !valid || !confirmed) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await (recovery ? recoveryApi.complete : invitationsApi.activate)(
        credential.id,
        credential.token,
        password,
      );
      setOutcome("done");
      setCredential(null);
    } catch (e) {
      const code = apiErrorStatus(e);
      if (!code || code >= 500) {
        setOutcome("uncertain");
        setCredential(null);
      } else
        setError(
          recovery
            ? t(
                "აღდგენა ვერ შესრულდა. გადაამოწმეთ ბმულის ვადა და აირჩიეთ ახალი პაროლი.",
                "Recovery failed. Check the link lifetime and choose a new password.",
              )
            : t(
                "აქტივაცია ვერ შესრულდა. გადაამოწმეთ ბმულის ვადა და პაროლის მოთხოვნები.",
                "Activation failed. Check the invitation lifetime and password requirements.",
              ),
        );
    } finally {
      setPassword("");
      setRepeat("");
      setConfirmed(false);
      setBusy(false);
      lock.current = false;
    }
  }
  return (
    <main className="activation-page">
      <div className="review-page activation-form">
        <Card>
          <h1 className="text-2xl font-bold">
            {recovery
              ? t("ახალი პაროლის დაყენება", "Set a new password")
              : t("ვებანგარიშის აქტივაცია", "Activate web account")}
          </h1>
          {outcome ? (
            <>
              <p
                role={outcome === "done" ? "status" : "alert"}
                className="my-4"
              >
                {outcome === "done"
                  ? recovery
                    ? t(
                        "პაროლი შეცვლილია და ძველი სესიები დახურულია. შედით ახალი პაროლით.",
                        "Password changed and old sessions closed. Sign in with your new password.",
                      )
                    : t(
                        "ანგარიში გააქტიურებულია. შედით მოწვევის ელფოსტით და თქვენ მიერ დაყენებული პაროლით.",
                        "Account activated. Sign in using the invitation email and your chosen password.",
                      )
                  : recovery
                    ? t(
                        "შედეგი გაურკვეველია. სცადეთ ახალი პაროლით შესვლა. აღდგენა ავტომატურად არ განმეორდება.",
                        "Outcome uncertain. Try signing in with your new password. Recovery will not be retried automatically.",
                      )
                    : t(
                        "შედეგი გაურკვეველია. სცადეთ შესვლა მოწვევის ელფოსტითა და არჩეული პაროლით; თუ ვერ შედიხართ, მიმართეთ მომწვევ ადმინისტრატორს. ავტომატური განმეორება არ მოხდება.",
                        "Outcome uncertain. Try signing in with the invitation email and chosen password; contact the inviting administrator if this fails. This action will not be retried automatically.",
                      )}
              </p>
              <a
                className="underline inline-flex min-h-11 items-center"
                href="/login"
              >
                {t("შესვლა", "Sign in")}
              </a>
            </>
          ) : !credential ? (
            <p role="alert" className="my-4">
              {recovery
                ? t(
                    "გახსენით სრული, მოქმედი აღდგენის ბმული.",
                    "Open a complete, valid recovery link.",
                  )
                : t(
                    "გახსენით სრული, მოქმედი მოწვევის ბმული.",
                    "Open a complete, valid invitation link.",
                  )}
            </p>
          ) : (
            <form onSubmit={(e) => void submit(e)} className="space-y-4 mt-4">
              <p>
                {recovery
                  ? t(
                      "აირჩიეთ ახალი პაროლი და დაადასტურეთ. ანგარიშის ყველა ძველი სესია დაიხურება; უფლებები არ შეიცვლება.",
                      "Choose a new password and confirm. All old account sessions will close; permissions remain unchanged.",
                    )
                  : t(
                      "ბმულის გახსნა ანგარიშს არ ააქტიურებს. აირჩიეთ პაროლი და დაადასტურეთ. პოზიცია და უფლებები ცალკე იმართება.",
                      "Opening this link does not activate the account. Choose a password and confirm. Positions and permissions are managed separately.",
                    )}
              </p>
              {error && <p role="alert">{error}</p>}
              <fieldset disabled={busy} className="space-y-4">
                <Input
                  label={t("პაროლი", "Password")}
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setConfirmed(false);
                  }}
                />
                <Input
                  label={t("გაიმეორეთ პაროლი", "Repeat password")}
                  type="password"
                  autoComplete="new-password"
                  value={repeat}
                  onChange={(e) => {
                    setRepeat(e.target.value);
                    setConfirmed(false);
                  }}
                />
                <p>
                  {t(
                    "მინიმუმ 14 სიმბოლო, მაქსიმუმ 72 UTF-8 ბაიტი.",
                    "At least 14 characters, at most 72 UTF-8 bytes.",
                  )}
                </p>
                <label className="flex gap-3 items-center min-h-11">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />
                  {recovery
                    ? t(
                        "ვადასტურებ პაროლის შეცვლასა და ძველი სესიების დახურვას",
                        "I confirm changing the password and closing old sessions",
                      )
                    : t(
                        "ვადასტურებ ანგარიშის აქტივაციას",
                        "I confirm account activation",
                      )}
                </label>
                <Button type="submit" disabled={!valid || !confirmed}>
                  {recovery
                    ? t("პაროლის შეცვლა", "Reset password")
                    : t("ანგარიშის აქტივაცია", "Activate account")}
                </Button>
              </fieldset>
            </form>
          )}
        </Card>
      </div>
    </main>
  );
}
