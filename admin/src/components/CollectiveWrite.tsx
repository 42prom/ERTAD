import { useRef, useState } from "react";
import { collectiveApi, type CollectiveWrite } from "../api/collective";
import { demoApi } from "../api/demo";
import { useConsolePreferences } from "./useConsolePreferences";
import Card from "./ui/Card";
import Button from "./ui/Button";
export function useCollectiveWrite(demo: boolean, onResult: () => void) {
  const { language } = useConsolePreferences(),
    [pending, setPending] = useState<CollectiveWrite | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(''),
    lock = useRef(false);
  const t = (ka: string, en: string) => (language === "ka" ? ka : en);
  async function send(input: CollectiveWrite, retry = false) {
    if (lock.current || (pending && !retry)) return false;
    lock.current = true;
    setBusy(true);
    setError("");
    setSaved('');
    const command = structuredClone(input);
    setPending(command);
    try {
      if (demo) await demoApi.stepUp();
      await collectiveApi.write(command);
      setPending(null);
      setSaved(command.operation);
      onResult();
      window.dispatchEvent(new Event("ertad-reviews-changed"));
      return true;
    } catch (e) {
      const status = (e as { response?: { status?: number } }).response?.status;
      if (status && status >= 400 && status < 500) {
        setPending(null);
        if (status === 403 || status === 409) onResult();
      }
      setError(
        status === 403
          ? t(
              "ამ მოქმედების უფლება აღარ გაქვთ.",
              "You no longer have permission for this action.",
            )
          : status === 409
            ? t(
                "მდგომარეობა შეიცვალა ან მოთხოვნის პირობები არ სრულდება. გადაამოწმეთ მონაცემები.",
                "State changed or the request conditions are not met. Review the current records.",
              )
            : status === 400
              ? t(
                  "შეამოწმეთ ფორმის ველები და თანხა.",
                  "Check the fields and amount.",
                )
              : t(
                  "შედეგი ვერ დადასტურდა. გაიმეორეთ იგივე მოთხოვნა.",
                  "The result is unconfirmed. Retry the same request.",
                ),
      );
      return false;
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const feedback = (
    <>
      {error && (
        <Card>
          <p role="alert">{error}</p>
        </Card>
      )}
      {saved && (
        <p role="status">
          {saved === 'propose' ? t(
            "შენახულია. დამტკიცებამდე ცვლილება ძალაში არ შედის.",
            "Saved. Proposed changes take effect only after approval.",
          ) : t('შენახულია.', 'Saved.')}
        </p>
      )}
      {pending && !busy && (
        <Card>
          <p>
            {t(
              "დასადასტურებელია მოთხოვნის შედეგი.",
              "The request result is awaiting confirmation.",
            )}
          </p>
          <Button onClick={() => void send(pending, true)}>
            {t("იგივე მოთხოვნის გამეორება", "Retry same request")}
          </Button>
        </Card>
      )}
    </>
  );
  return { send, locked: busy || !!pending, feedback };
}
