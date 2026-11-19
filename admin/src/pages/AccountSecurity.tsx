import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { accountApi, type OwnSession } from "../api/account";
import { authApi } from "../api/client";
import { apiErrorStatus } from "../api/errors";
import { useAsyncResource } from "../components/useAsyncResource";
import { useConsolePreferences } from "../components/useConsolePreferences";
import Card from "../components/ui/Card";
import Button from "../components/ui/Button";
import Input from "../components/ui/Input";
import OwnRecovery from "../components/OwnRecovery";
import OwnEmailChange from '../components/OwnEmailChange';
import OwnMfaAndPasskeys from "../components/OwnMfaAndPasskeys";
import OwnNotifications from "../components/OwnNotifications";

export default function AccountSecurity() {
  const { language } = useConsolePreferences();
  const t = (ka: string, en: string) => (language === "ka" ? ka : en);
  const [revision, setRevision] = useState(0),
    [before, setBefore] = useState<string>();
  const load = useCallback(() => accountApi.sessions(before), [before]);
  const resource = useAsyncResource(JSON.stringify([before, revision]), load);
  const [password, setPassword] = useState(""),
    [newPassword, setNewPassword] = useState(""),
    [repeat, setRepeat] = useState("");
  const [target, setTarget] = useState<OwnSession | "others" | null>(null),
    [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [signedOut, setSignedOut] = useState(false),
    [uncertain, setUncertain] = useState(false);
  const lock = useRef(false);
  const actionHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (target) actionHeading.current?.focus();
  }, [target]);
  useEffect(() => {
    const refresh = () => setRevision((v) => v + 1);
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);
  const validPassword =
    newPassword.length >= 14 &&
    new TextEncoder().encode(newPassword).length <= 72 &&
    repeat === newPassword;
  const date = (value: string) =>
    new Date(value).toLocaleString(language === "ka" ? "ka-GE" : "en-GB", {
      hour12: false,
    });
  async function submit(e: FormEvent, kind: "password" | "session") {
    e.preventDefault();
    if (
      lock.current ||
      !confirmed ||
      !password ||
      (kind === "password" && !validPassword) ||
      (kind === "session" && !target)
    )
      return;
    lock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    let mutationStarted = false;
    try {
      // Always confirm the real current password; the demo shortcut does not change credentials.
      await authApi.stepUp(password);
      setPassword("");
      mutationStarted = true;
      if (kind === "password") {
        await accountApi.changePassword(newPassword);
        sessionStorage.removeItem("admin_csrf");
        sessionStorage.removeItem("admin_user");
        setNewPassword("");
        setRepeat("");
        setSignedOut(true);
      } else {
        if (target === "others") {
          const result = await accountApi.revokeOthers();
          setNotice(
            t(
              `სხვა სესიები დახურულია (${result.revokedCount}). მიმდინარე სესია შენარჩუნებულია.`,
              `Other sessions closed (${result.revokedCount}). Your current session remains active.`,
            ),
          );
        } else {
          await accountApi.revoke(target!.id);
          setNotice(
            t("არჩეული სესია გაუქმებულია.", "Selected session revoked."),
          );
        }
        setTarget(null);
        setConfirmed(false);
        setBefore(undefined);
        setRevision((v) => v + 1);
      }
    } catch (e) {
      const status = apiErrorStatus(e);
      if (
        kind === "password" &&
        mutationStarted &&
        (!status || status >= 500)
      ) {
        setNewPassword("");
        setRepeat("");
        setUncertain(true);
      } else
        setError(
          t(
            "მოქმედება ვერ დადასტურდა. გადაამოწმეთ პაროლი და მიმდინარე მონაცემები.",
            "The action could not be confirmed. Check your password and current data.",
          ),
        );
      if (kind === "session") {
        setPassword("");
        setConfirmed(false);
        setRevision((v) => v + 1);
        if (mutationStarted && (!status || status >= 500))
          setError(
            t(
              "სესიების დახურვის შედეგი ვერ დადასტურდა. გადაამოწმეთ განახლებული სია; მოქმედება ავტომატურად არ განმეორდება. ხელახლა დადასტურებამ შეიძლება ამ შუალედში შექმნილი სესიებიც დახუროს.",
              "The session revocation outcome is uncertain. Check the refreshed list; this action will not be retried automatically. Confirming again may also close sessions created in the meantime.",
            ),
          );
      }
    } finally {
      setBusy(false);
      lock.current = false;
    }
  }
  if (signedOut || uncertain)
    return (
      <div className="review-page">
        <Card>
          <h1 className="text-2xl font-bold">
            {t("ანგარიშის უსაფრთხოება", "Account security")}
          </h1>
          <p role={uncertain ? "alert" : "status"} className="my-4">
            {uncertain
              ? t(
                  "პაროლის შეცვლის შედეგი ვერ დადასტურდა. თავიდან შედით ახალი პაროლით; თუ ის არ მიიღება, სცადეთ წინა პაროლი. ცვლილება ავტომატურად არ განმეორდება.",
                  "The password change outcome is uncertain. Sign in with the new password; if it is not accepted, try the previous password. This change will not be retried automatically.",
                )
              : t(
                  "პაროლი შეიცვალა და ყველა სესია დასრულდა. შედით ახალი პაროლით.",
                  "Password changed and all sessions ended. Sign in with your new password.",
                )}
          </p>
          <a
            className="underline text-primary-600 inline-flex min-h-11 items-center"
            href="/login"
          >
            {t("სისტემაში შესვლა", "Sign in")}
          </a>
        </Card>
      </div>
    );
  return (
    <div className="review-page">
      <header>
        <h1 className="text-2xl font-bold">
          {t("ანგარიშის უსაფრთხოება", "Account security")}
        </h1>
        <p className="mt-2">
          {t(
            "მართეთ თქვენი პაროლი და ვებ-სესიები. ორგანიზაციული უფლებები ცალკე იმართება.",
            "Manage your password and web sessions. Organizational permissions are managed separately.",
          )}
        </p>
      </header>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <OwnRecovery />
      <OwnEmailChange />
      <OwnMfaAndPasskeys />
      <OwnNotifications />
      <Card>
        <h2 className="text-lg font-semibold">
          {t("ჩემი აქტიური სესიები", "My active sessions")}
        </h2>
        <p className="my-2">
          {t(
            "ეს სია აჩვენებს ვებ-სესიებს; მოწყობილობის სანდოობას არ ადასტურებს.",
            "This list shows web sessions; it does not certify device integrity.",
          )}
        </p>
        {resource.loading && <p role="status">{t("იტვირთება…", "Loading…")}</p>}
        {resource.failed && (
          <p role="alert">
            {t("სესიები ვერ ჩაიტვირთა.", "Sessions could not load.")}
          </p>
        )}
        <div className="flex flex-wrap gap-3 my-3">
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => setRevision((v) => v + 1)}
          >
            {t("განახლება", "Refresh sessions")}
          </Button>
          {resource.data && (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                if (target === "others") actionHeading.current?.focus();
                setTarget("others");
                setConfirmed(false);
                setPassword("");
                setNewPassword("");
                setRepeat("");
                setError("");
                setNotice("");
              }}
            >
              {t("ყველა სხვა სესიის დახურვა", "Close all other sessions")}
            </Button>
          )}
        </div>
        {resource.data && (
          <>
            <div className="overflow-x-auto mt-4">
              <table className="w-full text-left">
                <thead>
                  <tr>
                    <th className="p-2">{t("სესია", "Session")}</th>
                    <th className="p-2">
                      {t("ბოლო აქტივობა", "Last activity")}
                    </th>
                    <th className="p-2">{t("მოქმედება", "Action")}</th>
                  </tr>
                </thead>
                <tbody>
                  {resource.data.items.map((s) => (
                    <tr key={s.id}>
                      <td className="p-2">
                        <p>
                          {s.current
                            ? t("მიმდინარე სესია", "Current session")
                            : t("სხვა სესია", "Other session")}
                          {s.clientLabel ? ` · ${s.clientLabel}` : ""}
                        </p>
                        <small>
                          {t("შეიქმნა: ", "Created: ")}
                          {date(s.createdAt)}
                        </small>
                      </td>
                      <td className="p-2">
                        {date(s.lastSeenAt)}
                        <p className="text-sm">
                          {t("ვადა: ", "Expires: ")}
                          {date(s.expiresAt)}
                        </p>
                      </td>
                      <td className="p-2">
                        {!s.current && (
                          <Button
                            variant="secondary"
                            disabled={busy}
                            onClick={() => {
                              if (target === s) actionHeading.current?.focus();
                              setTarget(s);
                              setConfirmed(false);
                              setPassword("");
                              setNewPassword("");
                              setRepeat("");
                              setError("");
                              setNotice("");
                            }}
                          >
                            {t("სესიის გაუქმება", "Revoke session")}
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!resource.data.items.length && (
              <p>
                {t(
                  "აქტიური სესიები ვერ მოიძებნა.",
                  "No active sessions found.",
                )}
              </p>
            )}
            <div className="flex gap-3 mt-3">
              <Button
                variant="secondary"
                disabled={!before || busy}
                onClick={() => setBefore(undefined)}
              >
                {t("პირველი გვერდი", "First page")}
              </Button>
              <Button
                variant="secondary"
                disabled={!resource.data.nextBefore || busy}
                onClick={() => setBefore(resource.data!.nextBefore!)}
              >
                {t("შემდეგი", "Next")}
              </Button>
            </div>
          </>
        )}
      </Card>
      <Card>
        <form
          className="space-y-4"
          onSubmit={(e) => void submit(e, target ? "session" : "password")}
        >
          <h2
            className="text-lg font-semibold"
            tabIndex={-1}
            ref={actionHeading}
          >
            {target === "others"
              ? t("ყველა სხვა სესიის დახურვა", "Close all other sessions")
              : target
                ? t("სესიის გაუქმება", "Revoke session")
                : t("პაროლის შეცვლა", "Change password")}
          </h2>
          <p>
            {target === "others"
              ? t(
                  "დასრულდება თქვენი ყველა სხვა ვებ-სესია, სიის სხვა გვერდებზე არსებულიც. მიმდინარე სესია შენარჩუნდება. ეს მოქმედება მომავალ შესვლებს არ ბლოკავს; თუ პაროლი სხვამ იცის, შეცვალეთ ისიც.",
                  "Every other web session will end, including sessions on other pages. Your current session stays active. This does not block future sign-ins; change your password too if somebody else knows it.",
                )
              : target
                ? t(
                    "დასრულდება მხოლოდ არჩეული სესია. მიმდინარე სესია შენარჩუნდება.",
                    "Only the selected session ends. Your current session remains active.",
                  )
                : t(
                    "გამოიყენეთ მინიმუმ 14 სიმბოლო, მაქსიმუმ 72 UTF-8 ბაიტი. ცვლილების შემდეგ ყველა სესია დასრულდება, მათ შორის მიმდინარე.",
                    "Use at least 14 characters, at most 72 UTF-8 bytes. Changing the password ends every session, including this one.",
                  )}
          </p>
          {target && target !== "others" && (
            <p>
              {t("სესიის შექმნის დრო: ", "Session created: ")}
              {date(target.createdAt)}
            </p>
          )}
          <fieldset disabled={busy} className="space-y-4">
            <Input
              label={t("მიმდინარე პაროლი", "Current password")}
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {!target && (
              <>
                <Input
                  label={t("ახალი პაროლი", "New password")}
                  type="password"
                  autoComplete="new-password"
                  required
                  value={newPassword}
                  onChange={(e) => {
                    setNewPassword(e.target.value);
                    setConfirmed(false);
                  }}
                />
                <Input
                  label={t("გაიმეორეთ ახალი პაროლი", "Repeat new password")}
                  type="password"
                  autoComplete="new-password"
                  required
                  value={repeat}
                  onChange={(e) => {
                    setRepeat(e.target.value);
                    setConfirmed(false);
                  }}
                />
              </>
            )}
            <label className="flex items-center gap-3 min-h-11">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              {t("ვადასტურებ ამ ცვლილებას", "I confirm this change")}
            </label>
            <div className="flex gap-3">
              <Button
                type="submit"
                disabled={
                  !confirmed || !password || (!target && !validPassword)
                }
              >
                {t("დადასტურება", "Confirm")}
              </Button>
              {target && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setTarget(null);
                    setPassword("");
                    setConfirmed(false);
                  }}
                >
                  {t("გაუქმება", "Cancel")}
                </Button>
              )}
            </div>
          </fieldset>
        </form>
      </Card>
    </div>
  );
}
