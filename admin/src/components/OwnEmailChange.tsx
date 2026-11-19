import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { emailChangeApi } from "../api/emailChange";
import { authApi } from "../api/client";
import { useAsyncResource } from "./useAsyncResource";
import { useConsolePreferences } from "./useConsolePreferences";
import Card from "./ui/Card";
import Button from "./ui/Button";
import Input from "./ui/Input";
type Action =
  | { kind: "request"; scope: string; requestId: string }
  | { kind: "cancel"; scope: string; id: string };
export default function OwnEmailChange() {
  const { language } = useConsolePreferences(),
    t = (ka: string, en: string) => (language === "ka" ? ka : en);
  const [revision, setRevision] = useState(0),
    [action, setAction] = useState<Action | null>(null);
  const load = useCallback(() => emailChangeApi.status(), []),
    resource = useAsyncResource(JSON.stringify([revision, language]), load);
  const [newEmail, setNewEmail] = useState(""),
    [password, setPassword] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [error, setError] = useState("");
  const lock = useRef(false),
    heading = useRef<HTMLHeadingElement>(null),
    actionButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (action) heading.current?.focus();
  }, [action]);
  useEffect(() => {
    const refresh = () => {
      if (!action && !lock.current) setRevision((v) => v + 1);
    };
    window.addEventListener("focus", refresh);
    const timer = window.setInterval(refresh, 30000);
    return () => {
      window.removeEventListener("focus", refresh);
      clearInterval(timer);
    };
  }, [action]);
  const data = resource.data,
    scope = JSON.stringify([
      data?.accountId,
      data?.currentEmail,
      data?.pending?.id,
    ]);
  const validEmail =
    /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(
      newEmail.trim().toLowerCase(),
    ) && newEmail.trim().toLowerCase() !== data?.currentEmail;
  const allowed =
    !!data &&
    !!action &&
    action.scope === scope &&
    (action.kind === "request"
      ? data.available && data.deliveryEnabled && !data.pending && validEmail
      : action.id === data.pending?.id);
  function open(kind: "request" | "cancel") {
    if (!data) return;
    setNotice("");
    setError("");
    setPassword("");
    setConfirmed(false);
    setNewEmail("");
    setAction(
      kind === "request"
        ? { kind, scope, requestId: crypto.randomUUID() }
        : { kind, scope, id: data.pending!.id },
    );
  }
  function close() {
    if (lock.current) return;
    setAction(null);
    setPassword("");
    setNewEmail("");
    setConfirmed(false);
    actionButton.current?.focus();
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (lock.current || !allowed || !confirmed || !password || !action) return;
    lock.current = true;
    setBusy(true);
    setNotice("");
    setError("");
    let started = false;
    try {
      await authApi.stepUp(password);
      setPassword("");
      started = true;
      if (action.kind === "request") {
        await emailChangeApi.request(
          action.requestId,
          newEmail.trim().toLowerCase(),
        );
        setNotice(
          t(
            "მოთხოვნა შენახულია. ახალ მისამართზე მიღებული ბმული გახსენით ამავე ანგარიშში შესვლის შემდეგ. დადასტურებამდე ძველი მისამართი მოქმედია.",
            "Request saved. Open the new-address link while signed in to this account. Your old address stays active until confirmation.",
          ),
        );
      } else {
        await emailChangeApi.cancel(action.id);
        setNotice(
          t(
            "ელფოსტის შეცვლის მოთხოვნა გაუქმებულია.",
            "Email change request cancelled.",
          ),
        );
      }
    } catch {
      setError(
        started
          ? t(
              "შედეგი ვერ დადასტურდა. გადაამოწმეთ განახლებული მდგომარეობა; მოთხოვნა ავტომატურად არ განმეორდება.",
              "The outcome is unconfirmed. Check the refreshed state; this request will not retry automatically.",
            )
          : t(
              "პაროლის დადასტურება ვერ მოხერხდა.",
              "Password confirmation failed.",
            ),
      );
    } finally {
      setPassword("");
      setNewEmail("");
      setConfirmed(false);
      setAction(null);
      setBusy(false);
      lock.current = false;
      resource.clear();
      setRevision((v) => v + 1);
    }
  }
  return (
    <Card>
      <h2>{t("შესვლის ელფოსტა", "Sign-in email")}</h2>
      <p>
        {t(
          "ახალი მისამართის დადასტურებამდე ძველი მოქმედი რჩება. წარმატებული ცვლილება ყველა სესიასა და ძველ აღდგენის ბმულებს გააუქმებს.",
          "Your old address stays active until the new address is confirmed. Completion closes all sessions and invalidates old recovery links.",
        )}
      </p>
      {resource.loading && <p role="status">{t("იტვირთება…", "Loading…")}</p>}
      {resource.failed && (
        <p role="alert">
          {t(
            "ელფოსტის მდგომარეობა ვერ ჩაიტვირთა.",
            "Could not load email status.",
          )}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
      {data && (
        <>
          <p className="break-all">{data.currentEmail}</p>
          {!data.available && (
            <p>
              {t(
                "ცვლილება ხელმისაწვდომია დადასტურებულ კონტაქტზე მიბმული ანგარიშისთვის.",
                "Changes require an account bound to a verified contact.",
              )}
            </p>
          )}
          {data.available && !data.deliveryEnabled && (
            <p>
              {t(
                "ელფოსტის მიწოდების სერვისი ჯერ არ არის ჩართული.",
                "Email delivery is not enabled yet.",
              )}
            </p>
          )}
          {data.pending ? (
            <div>
              <p className="break-all">
                {t("ახალი მისამართი", "New address")}: {data.pending.newEmail}
              </p>
              <p>
                {data.pending.mailStatus === "accepted"
                  ? t(
                      "წერილი მიღებულია პროვაიდერის მიერ; შემოსულ ფოსტაში მიწოდება ჯერ არ არის დადასტურებული.",
                      "The provider accepted the email; inbox delivery is not confirmed.",
                    )
                  : data.pending.mailStatus === "uncertain"
                    ? t(
                        "გაგზავნის შედეგი გაურკვეველია. ავტომატური ხელახალი გაგზავნა არ მოხდება.",
                        "The sending outcome is uncertain. It will not resend automatically.",
                      )
                    : ["failed", "cancelled"].includes(
                          data.pending.mailStatus ?? "",
                        )
                      ? t(
                          "წერილის გაგზავნა შეჩერებულია. გააუქმეთ მოთხოვნა და გადაამოწმეთ მისამართი ახალი მოთხოვნის შექმნამდე.",
                          "Email sending stopped. Cancel this request and check the address before creating another.",
                        )
                      : t(
                          "წერილი გაგზავნას ელოდება.",
                          "Email is awaiting delivery processing.",
                        )}
              </p>
              <p>
                {t("ვადა", "Expires")}:{" "}
                {new Date(data.pending.expiresAt).toLocaleString(
                  language === "ka" ? "ka-GE" : "en-GB",
                  { hour12: false },
                )}
              </p>
              {!data.pending.valid && (
                <p>
                  {t(
                    "მოთხოვნა აღარ არის მოქმედი. გააუქმეთ და შექმენით ახალი.",
                    "This request is no longer valid. Cancel it before creating another.",
                  )}
                </p>
              )}
              <Button
                ref={actionButton}
                variant="secondary"
                disabled={busy}
                onClick={() => open("cancel")}
              >
                {t("მოთხოვნის გაუქმება", "Cancel email request")}
              </Button>
            </div>
          ) : (
            <Button
              ref={actionButton}
              disabled={busy || !data.available || !data.deliveryEnabled}
              onClick={() => open("request")}
            >
              {t("მისამართის შეცვლა", "Change sign-in email")}
            </Button>
          )}
        </>
      )}
      <Button
        className="mt-3"
        variant="secondary"
        disabled={busy}
        onClick={() => setRevision((v) => v + 1)}
      >
        {t("განახლება", "Refresh email status")}
      </Button>
      {action && (
        <form
          onSubmit={submit}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              close();
            }
          }}
          className="space-y-4 mt-4"
        >
          <h3 ref={heading} tabIndex={-1}>
            {action.kind === "request"
              ? t("ახალი ელფოსტის დადასტურება", "Request a new email address")
              : t("მოთხოვნის გაუქმება", "Cancel the pending request")}
          </h3>
          {action.kind === "request" && (
            <Input
              label={t("ახალი ელფოსტა", "New email address")}
              type="email"
              required
              maxLength={254}
              autoComplete="email"
              value={newEmail}
              disabled={busy}
              onChange={(e) => {
                setNewEmail(e.target.value);
                setConfirmed(false);
              }}
            />
          )}
          <label className="flex gap-3 items-center min-h-11">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            {action.kind === "request"
              ? t(
                  "ვადასტურებ ჩემი შესვლის მისამართის შეცვლის მოთხოვნას.",
                  "I confirm requesting a change to my sign-in email.",
                )
              : t(
                  "ვადასტურებ შერჩეული მოთხოვნის გაუქმებას.",
                  "I confirm cancelling the selected email request.",
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
          <div className="flex flex-wrap gap-3">
            <Button
              type="submit"
              disabled={busy || !allowed || !password || !confirmed}
            >
              {t("დადასტურება", "Confirm email request")}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={close}
            >
              {t("დახურვა", "Close")}
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}
