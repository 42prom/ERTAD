import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { accountApi } from "../api/account";
import { authApi } from "../api/client";
import { useAsyncResource } from "./useAsyncResource";
import { useConsolePreferences } from "./useConsolePreferences";
import Card from "./ui/Card";
import Button from "./ui/Button";
import Input from "./ui/Input";

export default function OwnRecovery() {
  const { language } = useConsolePreferences();
  const t = (ka: string, en: string) => (language === "ka" ? ka : en);
  const [revision, setRevision] = useState(0);
  const load = useCallback(() => accountApi.recovery(), []);
  const resource = useAsyncResource(String(revision), load);
  const [selected, setSelected] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const lock = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (selected) heading.current?.focus();
  }, [selected]);
  useEffect(() => {
    const refresh = () => {
      if (!lock.current) setRevision((v) => v + 1);
    };
    window.addEventListener("focus", refresh);
    const timer = window.setInterval(refresh, 60000);
    return () => {
      window.removeEventListener("focus", refresh);
      window.clearInterval(timer);
    };
  }, []);
  const pending = resource.data?.pending;
  const canSubmit =
    selected && selected === pending?.id && password && confirmed;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (lock.current || !canSubmit || !selected) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    let started = false;
    try {
      await authApi.stepUp(password);
      setPassword("");
      started = true;
      await accountApi.cancelRecovery(selected);
      setNotice(
        t(
          "არჩეული აღდგენის ბმული გაუქმებულია. პაროლი და სესიები შენარჩუნებულია.",
          "Selected recovery link cancelled. Your password and sessions are unchanged.",
        ),
      );
    } catch {
      setError(
        started
          ? t(
              "გაუქმების შედეგი ვერ დადასტურდა. გადაამოწმეთ განახლებული მდგომარეობა; მოქმედება ავტომატურად არ განმეორდება.",
              "Cancellation could not be confirmed. Check the refreshed status; the action will not be retried automatically.",
            )
          : t(
              "პაროლის დადასტურება ვერ მოხერხდა. ბმულის გაუქმება არ გაგზავნილა.",
              "Password confirmation failed. No cancellation was sent.",
            ),
      );
    } finally {
      setPassword("");
      setConfirmed(false);
      setSelected(null);
      resource.clear();
      setRevision((v) => v + 1);
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <Card>
      <h2 className="text-lg font-semibold">
        {t("პაროლის აღდგენა", "Password recovery")}
      </h2>
      <p className="my-2">
        {t(
          "აქ ჩანს მხოლოდ თქვენი მიმდინარე მოთხოვნა. გაუქმება ბმულს აუქმებს; ანგარიშს არ თიშავს.",
          "Only your current request appears here. Cancellation invalidates the link; it does not disable your account.",
        )}
      </p>
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
      {resource.loading && <p role="status">{t("იტვირთება…", "Loading…")}</p>}
      {resource.failed && (
        <p role="alert">
          {t(
            "აღდგენის მდგომარეობა ვერ ჩაიტვირთა.",
            "Recovery status could not load.",
          )}
        </p>
      )}
      {resource.data && (
        <>
          <p className="my-2">
            {resource.data.available
              ? t(
                  "დეველოპმენტში აღდგენა ხელმისაწვდომია ლოკალური სატესტო საფოსტო არხით. რეალური ელფოსტა ჯერ არ იგზავნება.",
                  "Development recovery is available through the local test mailbox. Real email delivery is not enabled.",
                )
              : t(
                  "ამ ანგარიშისთვის თვითმომსახურებით აღდგენა ჯერ ხელმისაწვდომი არ არის.",
                  "Self-service recovery is not currently available for this account.",
                )}
          </p>
          {pending ? (
            <>
              <p>
                {pending.delivered
                  ? t("ბმული მომზადებულია.", "Recovery link prepared.")
                  : t(
                      "მოთხოვნა ელოდება ბმულის მომზადებას.",
                      "Request awaiting link preparation.",
                    )}
              </p>
              <p>
                {t("ვადა: ", "Expires: ")}
                {new Date(pending.expiresAt).toLocaleString(
                  language === "ka" ? "ka-GE" : "en-GB",
                  { hour12: false },
                )}
              </p>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  setSelected(pending.id);
                  setPassword("");
                  setConfirmed(false);
                  setError("");
                  setNotice("");
                }}
              >
                {t("აღდგენის ბმულის გაუქმება", "Cancel recovery link")}
              </Button>
            </>
          ) : (
            <p>
              {t(
                "მოქმედი აღდგენის მოთხოვნა არ არის.",
                "No active recovery request.",
              )}
            </p>
          )}
        </>
      )}
      <Button
        variant="secondary"
        disabled={busy}
        onClick={() => setRevision((v) => v + 1)}
      >
        {t("აღდგენის მდგომარეობის განახლება", "Refresh recovery status")}
      </Button>
      {selected && (
        <form onSubmit={submit} className="space-y-3 mt-4">
          <h3 ref={heading} tabIndex={-1}>
            {t("ბმულის გაუქმების დადასტურება", "Confirm link cancellation")}
          </h3>
          <Input
            label={t(
              "მიმდინარე პაროლი ბმულის გასაუქმებლად",
              "Current password to cancel link",
            )}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
          />
          <label className="flex gap-2 items-start">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              disabled={busy}
            />
            {t(
              "ვადასტურებ არჩეული აღდგენის ბმულის გაუქმებას.",
              "I confirm cancellation of the selected recovery link.",
            )}
          </label>
          <div className="flex gap-3">
            <Button type="submit" disabled={busy || !canSubmit}>
              {t("ბმულის გაუქმების დადასტურება", "Confirm cancellation")}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setSelected(null);
                setPassword("");
                setConfirmed(false);
              }}
            >
              {t("დახურვა", "Close cancellation")}
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}
