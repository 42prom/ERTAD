import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { emailChangeApi } from "../api/emailChange";
import { authApi } from "../api/client";
import { apiErrorStatus } from "../api/errors";
import { useAsyncResource } from "../components/useAsyncResource";
import { useConsolePreferences } from "../components/useConsolePreferences";
import Card from "../components/ui/Card";
import Button from "../components/ui/Button";
import Input from "../components/ui/Input";
function readLink() {
  const match =
    /^#([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/i.exec(
      window.location.hash,
    );
  return match ? { id: match[1], token: match[2] } : null;
}
export default function ConfirmEmailChange() {
  const { language } = useConsolePreferences(),
    t = (ka: string, en: string) => (language === "ka" ? ka : en);
  const [link, setLink] = useState(readLink),
    [revision, setRevision] = useState(0),
    [password, setPassword] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [outcome, setOutcome] = useState<"done" | "unknown" | null>(null),
    [error, setError] = useState("");
  const lock = useRef(false);
  useEffect(() => {
    const clear = () =>
      window.history.replaceState(
        window.history.state,
        "",
        window.location.pathname,
      );
    clear();
    const change = () => {
      const next = readLink();
      clear();
      if (lock.current) return;
      setLink(next);
      setPassword("");
      setConfirmed(false);
      setOutcome(null);
      setError("");
      setRevision((v) => v + 1);
    };
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  const load = useCallback(
    () => (link ? emailChangeApi.status() : Promise.resolve(null)),
    [link],
  );
  const resource = useAsyncResource(
      JSON.stringify([link?.id, revision, language]),
      load,
    ),
    data = resource.data;
  const valid =
    !!link &&
    !!data?.pending &&
    data.pending.id === link.id &&
    data.pending.valid;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (
      lock.current ||
      !valid ||
      !confirmed ||
      !password ||
      !link ||
      !data?.pending
    )
      return;
    lock.current = true;
    setBusy(true);
    setError("");
    let started = false;
    try {
      await authApi.stepUp(password);
      setPassword("");
      started = true;
      await emailChangeApi.confirm(link.id, link.token, data.pending.newEmail);
      sessionStorage.removeItem("admin_csrf");
      sessionStorage.removeItem("admin_user");
      setOutcome("done");
    } catch {
      if (started) setOutcome("unknown");
      else
        setError(
          t(
            "პაროლის დადასტურება ვერ მოხერხდა.",
            "Password confirmation failed.",
          ),
        );
    } finally {
      setPassword("");
      setConfirmed(false);
      setBusy(false);
      lock.current = false;
      if (started) {
        setLink(null);
        resource.clear();
      }
    }
  }
  return (
    <main className="activation-page">
      <div className="review-page activation-form">
        <Card>
          <h1>{t("ელფოსტის ცვლილების დადასტურება", "Confirm email change")}</h1>
          {outcome ? (
            <>
              <p role="status">
                {outcome === "done"
                  ? t(
                      "მისამართი შეიცვალა და ყველა სესია დაიხურა. შედით ახალი მისამართით და თქვენი არსებული პაროლით.",
                      "Email changed and all sessions closed. Sign in with your new address and existing password.",
                    )
                  : t(
                      "შედეგი ვერ დადასტურდა. შედით ანგარიშში მიმდინარე მისამართით და გადაამოწმეთ მდგომარეობა; ცვლილება ავტომატურად არ განმეორდება.",
                      "The outcome is unconfirmed. Sign in using your current address to check the state; this change will not retry automatically.",
                    )}
              </p>
              <a
                className="underline inline-flex min-h-11 items-center"
                href="/login"
              >
                {t("შესვლა", "Sign in")}
              </a>
            </>
          ) : !link ? (
            <p>
              {t(
                "გახსენით ახალ ელფოსტაზე მიღებული ბმული.",
                "Open the link received at your new email address.",
              )}
            </p>
          ) : resource.loading ? (
            <p role="status">{t("იტვირთება…", "Loading…")}</p>
          ) : resource.failed ? (
            <>
              <p role="alert">
                {apiErrorStatus(resource.cause) === 401
                  ? t(
                      "ჯერ შედით იმ ანგარიშში, რომელმაც ცვლილება მოითხოვა, შემდეგ ხელახლა გახსენით ეს ბმული.",
                      "Sign in to the account that requested this change, then reopen this email link.",
                    )
                  : t(
                      "მოთხოვნა ვერ ჩაიტვირთა.",
                      "Could not load this request.",
                    )}
              </p>
              <a
                className="underline inline-flex min-h-11 items-center"
                href="/login"
              >
                {t("შესვლა", "Sign in")}
              </a>
              <Button
                variant="secondary"
                onClick={() => setRevision((v) => v + 1)}
              >
                {t("განახლება", "Retry loading")}
              </Button>
            </>
          ) : !valid ? (
            <p role="alert">
              {t(
                "ეს ბმული ამ ანგარიშის მოქმედ მოთხოვნას არ შეესაბამება.",
                "This link does not match a valid request for this account.",
              )}
            </p>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <p>
                {t("ახალი მისამართი", "New address")}:{" "}
                <span className="break-all">{data!.pending!.newEmail}</span>
              </p>
              <p>
                {t(
                  "დადასტურება ყველა სესიასა და ძველ აღდგენის ბმულებს გააუქმებს. ძველ მისამართზე უსაფრთხოების შეტყობინება მომზადდება.",
                  "Confirmation closes all sessions and invalidates old recovery links. A security notice will be queued for the old address.",
                )}
              </p>
              {error && <p role="alert">{error}</p>}
              <label className="flex gap-3 items-center min-h-11">
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={busy}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                {t(
                  "ვადასტურებ ჩემი შესვლის მისამართის შეცვლას.",
                  "I confirm changing my sign-in email.",
                )}
              </label>
              <Input
                label={t("მიმდინარე პაროლი", "Current password")}
                type="password"
                autoComplete="current-password"
                value={password}
                disabled={busy}
                onChange={(e) => setPassword(e.target.value)}
              />
              <Button
                type="submit"
                disabled={busy || !password || !confirmed || !valid}
              >
                {t("მისამართის შეცვლა", "Confirm address change")}
              </Button>
            </form>
          )}
        </Card>
      </div>
    </main>
  );
}
