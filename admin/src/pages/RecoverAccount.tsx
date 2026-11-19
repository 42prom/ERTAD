import { useEffect, useRef, useState, type FormEvent } from "react";
import { recoveryApi } from "../api/recovery";
import { useConsolePreferences } from "../components/useConsolePreferences";
import Card from "../components/ui/Card";
import Input from "../components/ui/Input";
import Button from "../components/ui/Button";
import ActivateAccount from "./ActivateAccount";

export default function RecoverAccount() {
  const [link, setLink] = useState(() => ({
    present: !!window.location.hash,
    revision: 0,
  }));
  useEffect(() => {
    const update = () => {
      if (window.location.hash)
        setLink((previous) => ({
          present: true,
          revision: previous.revision + 1,
        }));
    };
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  const { language } = useConsolePreferences(),
    t = (ka: string, en: string) => (language === "ka" ? ka : en);
  const [email, setEmail] = useState(""),
    [busy, setBusy] = useState(false),
    [sent, setSent] = useState(false),
    [error, setError] = useState("");
  const lock = useRef(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (lock.current || !email.trim()) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await recoveryApi.request(email.trim());
      setSent(true);
      setEmail("");
    } catch {
      setError(
        t(
          "მოთხოვნა ვერ დადასტურდა. დაელოდეთ და სცადეთ ხელახლა.",
          "Request could not be confirmed. Wait before trying again.",
        ),
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  if (link.present) return <ActivateAccount key={link.revision} recovery />;
  return (
    <main className="activation-page">
      <div className="review-page activation-form">
        <Card>
          <h1>{t("პაროლის აღდგენა", "Recover password")}</h1>
          {sent ? (
            <p role="status">
              {t(
                "თუ მითითებული კონტაქტით აღდგენა ხელმისაწვდომია, აღდგენის ინსტრუქცია მომზადდება. განმეორებითი მოთხოვნა მოქმედ ბმულს არ ცვლის.",
                "If recovery is available for that contact, recovery instructions will be prepared. Repeating the request does not replace a valid link.",
              )}
            </p>
          ) : (
            <form onSubmit={(e) => void submit(e)} className="space-y-4">
              <p>
                {t(
                  "მიუთითეთ ანგარიშზე უკვე მიბმული ელფოსტა.",
                  "Enter the email already bound to your account.",
                )}
              </p>
              <Input
                label={t("ელფოსტა", "Email")}
                type="email"
                autoComplete="email"
                required
                maxLength={254}
                value={email}
                disabled={busy}
                onChange={(e) => setEmail(e.target.value)}
              />
              {error && <p role="alert">{error}</p>}
              <Button type="submit" disabled={busy || !email.trim()}>
                {t("აღდგენის ბმულის მოთხოვნა", "Request recovery link")}
              </Button>
            </form>
          )}
          <a
            href="/login"
            className="underline inline-flex min-h-11 items-center"
          >
            {t("შესვლა", "Sign in")}
          </a>
        </Card>
      </div>
    </main>
  );
}
