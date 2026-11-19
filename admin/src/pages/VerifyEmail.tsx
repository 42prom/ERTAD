import { useEffect, useRef, useState, type FormEvent } from "react";
import { invitationsApi } from "../api/invitations";
import { useConsolePreferences } from "../components/useConsolePreferences";
import Card from "../components/ui/Card";
import Button from "../components/ui/Button";
function readCredential() {
  const match =
    /^#([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/i.exec(
      window.location.hash,
    );
  return match ? { id: match[1], token: match[2] } : null;
}
export default function VerifyEmail() {
  const { language } = useConsolePreferences(),
    t = (ka: string, en: string) => (language === "ka" ? ka : en);
  const [credential, setCredential] = useState(readCredential),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [outcome, setOutcome] = useState<"done" | "unknown" | null>(null);
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
      const next = readCredential();
      clear();
      if (lock.current) return;
      setCredential(next);
      setConfirmed(false);
      setOutcome(null);
    };
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (lock.current || !credential || !confirmed) return;
    lock.current = true;
    setBusy(true);
    try {
      await invitationsApi.confirmEmail(credential.id, credential.token);
      setOutcome("done");
    } catch {
      setOutcome("unknown");
    } finally {
      setCredential(null);
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
            {t("ელფოსტის დადასტურება", "Confirm email address")}
          </h1>
          {outcome ? (
            <p role="status">
              {outcome === "done"
                ? t(
                    "ელფოსტა დადასტურებულია. აქტივაციის ბმული ცალკე წერილით გამოგეგზავნებათ. ანგარიში ჯერ არ გააქტიურებულა.",
                    "Email confirmed. An activation link will follow in a separate message. Your account is not activated yet.",
                  )
                : t(
                    "შედეგი ვერ დადასტურდა. ბმული შეიძლება ვადაგასული ან გამოყენებული იყოს. გადაამოწმეთ მიღებული წერილები.",
                    "The outcome is unconfirmed. The link may be expired or used. Check your received messages.",
                  )}
            </p>
          ) : !credential ? (
            <p>
              {t(
                "გახსენით ელფოსტით მიღებული ბმული.",
                "Open the link received by email.",
              )}
            </p>
          ) : (
            <form onSubmit={submit} className="space-y-4 mt-4">
              <p>
                {t(
                  "დადასტურება აჩვენებს მხოლოდ ამ მისამართზე წვდომას. ის არ ქმნის ანგარიშს და არ ანიჭებს უფლებებს.",
                  "Confirmation proves access to this address only. It does not create an account or grant permissions.",
                )}
              </p>
              <label className="flex gap-3">
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={busy}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                {t(
                  "ეს ჩემი მისამართია და ველოდები ERTAD-ის მოწვევას.",
                  "This is my address and I expect an ERTAD invitation.",
                )}
              </label>
              <Button type="submit" disabled={busy || !confirmed}>
                {t("დადასტურება", "Confirm")}
              </Button>
            </form>
          )}
        </Card>
      </div>
    </main>
  );
}
