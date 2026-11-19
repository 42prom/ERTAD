import { useAsyncResource } from "./useAsyncResource";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { channelsApi, type ChannelWrite } from "../api/channels";
import { demoApi } from "../api/demo";
import { useConsolePreferences } from "./useConsolePreferences";
import Button from "./ui/Button";

/** Task and channel authority are rechecked by the API, never inferred from the button. */
export default function TaskConversation({
  organizationId,
  workId,
  version,
  demo,
  disabled = false,
}: {
  organizationId: string;
  workId: string;
  version: number;
  demo: boolean;
  disabled?: boolean;
}) {
  const { language } = useConsolePreferences(),
    t = (ka: string, en: string) => (language === "ka" ? ka : en),
    navigate = useNavigate();
  const [busy, setBusy] = useState(false),
    [pending, setPending] = useState<ChannelWrite | null>(null),
    [revision, setRevision] = useState(0);
  const lock = useRef(false),
    mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const resourceKey = JSON.stringify([
    organizationId,
    workId,
    version,
    revision,
  ]);
  const load = useCallback(
    () => channelsApi.work(organizationId, workId),
    [organizationId, workId],
  );
  const { data, failed, cause, clear } = useAsyncResource(resourceKey, load);
  const [actionError, setActionError] = useState({ key: "", message: "" });
  const setError = (message: string) =>
    setActionError({ key: resourceKey, message });
  const error =
    (actionError.key === resourceKey ? actionError.message : "") ||
    (failed
      ? (cause as { response?: { status?: number } } | undefined)?.response
          ?.status === 403
        ? t(
            "დავალების მიმოწერაზე წვდომა არ გაქვთ.",
            "You do not have access to this task conversation.",
          )
        : t(
            "მიმოწერის ჩატვირთვა ვერ მოხერხდა.",
            "Could not load the task conversation.",
          )
      : "");
  useEffect(() => {
    if (!pending) return;
    const guard = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [pending]);
  function open(id: string) {
    navigate("/channels", { state: { channel: { organizationId, id } } });
  }
  async function create() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    const input = pending ?? {
      operation: "work-create" as const,
      organizationId,
      workId,
      key: crypto.randomUUID(),
    };
    setPending(input);
    try {
      if (demo) await demoApi.stepUp();
      if (!mounted.current) return;
      const result = await channelsApi.write(input);
      if (!mounted.current) return;
      setPending(null);
      open(result.id);
    } catch (e) {
      const status = (e as { response?: { status?: number } }).response?.status;
      if (!mounted.current) return;
      if (status && status >= 400 && status < 500) setPending(null);
      clear();
      setError(
        t(
          "მიმოწერის გახსნა ვერ დადასტურდა. გაიმეორეთ მოთხოვნა.",
          "Could not confirm the conversation. Retry the request.",
        ),
      );
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <section
      aria-label={t("დავალების მიმოწერა", "Task conversation")}
      className="my-4 space-y-2"
    >
      <p className="text-sm">
        {t(
          "მიმოწერა ხელმისაწვდომია უფლებამოსილი მმართველებისა და დანიშნული მონაწილეებისთვის.",
          "Conversation is available to authorized managers and assigned participants.",
        )}
      </p>
      {error && <p role="alert">{error}</p>}
      {pending ? (
        <Button disabled={disabled || busy} onClick={() => void create()}>
          {t("იგივე მოთხოვნის გამეორება", "Retry same request")}
        </Button>
      ) : data?.id ? (
        <Button
          variant="secondary"
          disabled={disabled || busy}
          onClick={() => open(data.id!)}
        >
          {t("დავალების მიმოწერა", "Open task conversation")}
        </Button>
      ) : data?.canCreate ? (
        <Button
          variant="secondary"
          disabled={disabled || busy}
          onClick={() => void create()}
        >
          {t("მიმოწერის შექმნა", "Create task conversation")}
        </Button>
      ) : data ? (
        <p>
          {t(
            "ამ დავალების მიმოწერა ჯერ არ შექმნილა.",
            "This task has no conversation yet.",
          )}
        </p>
      ) : error ? (
        <Button
          variant="ghost"
          disabled={disabled || busy}
          onClick={() => setRevision((v) => v + 1)}
        >
          {t("განახლება", "Refresh conversation")}
        </Button>
      ) : (
        <p role="status">{t("იტვირთება…", "Loading conversation…")}</p>
      )}
    </section>
  );
}
