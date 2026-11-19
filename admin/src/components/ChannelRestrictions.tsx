import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  channelsApi,
  type ChannelRestriction,
  type ChannelWrite,
} from "../api/channels";
import { demoApi } from "../api/demo";
import { useConsolePreferences } from "./useConsolePreferences";
import Card from "./ui/Card";
import Button from "./ui/Button";
import Select from "./ui/Select";
import Textarea from "./ui/Textarea";

export type RestrictionTarget = {
  id: string;
  messageId: string;
  participantTag: number;
};
type Action =
  | { operation: "restrict"; target: RestrictionTarget }
  | { operation: "appeal" | "review-appeal"; record: ChannelRestriction };
export default function ChannelRestrictions({
  organizationId,
  demo,
  target,
  initialRestrictionId,
  onClose,
  onChanged,
  onDirty,
}: {
  organizationId: string;
  demo: boolean;
  target?: RestrictionTarget;
  initialRestrictionId?: string;
  onClose: () => void;
  onChanged: () => void;
  onDirty: (dirty: boolean) => void;
}) {
  const { language } = useConsolePreferences(),
    t = (ka: string, en: string) => (language === "ka" ? ka : en);
  const [view, setView] = useState<"pending" | "mine" | "history">("pending"),
    [selectedId, setSelectedId] = useState(initialRestrictionId ?? ""),
    [page, setPage] = useState(1),
    [rows, setRows] = useState<ChannelRestriction[]>([]),
    [total, setTotal] = useState(0);
  const [action, setAction] = useState<Action | null>(
      target ? { operation: "restrict", target } : null,
    ),
    [reason, setReason] = useState(""),
    [hours, setHours] = useState("24"),
    [outcome, setOutcome] = useState("lift");
  const [pending, setPending] = useState<ChannelWrite | null>(null),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [revision, setRevision] = useState(0);
  const lock = useRef(false),
    mounted = useRef(false),
    heading = useRef<HTMLHeadingElement>(null);
  const dirty = !!action || !!pending || busy;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    onDirty(dirty);
    return () => onDirty(false);
  }, [dirty, onDirty]);
  useEffect(() => {
    if (!dirty) return;
    const guard = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);
  useEffect(() => {
    heading.current?.focus();
  }, [action]);
  const readScope1Key = JSON.stringify([
    organizationId,
    view,
    page,
    revision,
    language,
    selectedId,
  ]);
  const [readScope1, setReadScope1] = useState(readScope1Key);
  // Reconcile scope before committing children, so previous-scope records cannot flash.
  if (readScope1 !== readScope1Key) {
    setReadScope1(readScope1Key);
    setLoading(true);
  }
  useEffect(() => {
    let live = true;
    (selectedId
      ? channelsApi
          .restriction(organizationId, selectedId)
          .then((item) => ({ items: [item], total: 1 }))
      : channelsApi.restrictions(organizationId, view, page)
    )
      .then((result) => {
        if (live) {
          setRows(result.items);
          setTotal(result.total);
        }
      })
      .catch(() => {
        if (live) {
          setRows([]);
          setTotal(0);
          setError(
            t(
              "ჩანაწერების ჩატვირთვა ვერ მოხერხდა.",
              "Could not load restriction records.",
            ),
          );
        }
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [organizationId, view, page, revision, language, selectedId]);
  useEffect(() => {
    const refresh = () => {
      if (!dirty && document.visibilityState === "visible")
        setRevision((v) => v + 1);
    };
    const timer = setInterval(refresh, 15000);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [dirty]);
  const date = (value: string) =>
    new Date(value).toLocaleString(language === "ka" ? "ka-GE" : "en-GB", {
      hour12: false,
    });
  function begin(next: Action) {
    setAction(next);
    setReason("");
    setOutcome("lift");
    setError("");
    setNotice("");
  }
  async function send(input: ChannelWrite) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setPending(input);
    setError("");
    setNotice("");
    try {
      if (demo && input.operation !== "appeal") await demoApi.stepUp();
      if (!mounted.current) return;
      await channelsApi.write(input);
      if (!mounted.current) return;
      setPending(null);
      setAction(null);
      setReason("");
      setRevision((v) => v + 1);
      setNotice(t("მოქმედება ჩაიწერა.", "Action recorded."));
      window.dispatchEvent(new Event("ertad-inbox-changed"));
      onChanged();
    } catch (e) {
      if (!mounted.current) return;
      const status = (e as { response?: { status?: number } }).response?.status;
      setRows([]);
      setTotal(0);
      if (status && status >= 400 && status < 500) {
        setPending(null);
        setAction(null);
        setReason("");
        setRevision((v) => v + 1);
        onChanged();
      }
      setError(
        status === 403
          ? t(
              "ამ მოქმედების უფლება აღარ გაქვთ.",
              "You no longer have permission for this action.",
            )
          : status === 409
            ? t(
                "ჩანაწერი შეიცვალა. განაახლეთ და ხელახლა განიხილეთ.",
                "The record changed. Refresh and review it again.",
              )
            : t(
                "შედეგი დაუდასტურებელია. გაიმეორეთ იგივე მოთხოვნა.",
                "The result is unconfirmed. Retry the same request.",
              ),
      );
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!action || reason.trim().length < 10 || pending) return;
    const common = {
      organizationId,
      key: crypto.randomUUID(),
      reason: reason.trim(),
    };
    const input: ChannelWrite =
      action.operation === "restrict"
        ? {
            ...common,
            operation: "restrict",
            id: action.target.id,
            messageId: action.target.messageId,
            expiresAt: new Date(
              Date.now() + Number(hours) * 3600000,
            ).toISOString(),
          }
        : {
            ...common,
            operation: action.operation,
            id: action.record.channelId,
            restrictionId: action.record.id,
            version: action.record.version,
            ...(action.operation === "review-appeal" ? { outcome } : {}),
          };
    void send(input);
  }
  return (
    <Card>
      <section
        aria-label={t("შეზღუდვები და გასაჩივრება", "Restrictions and appeals")}
        className="space-y-4"
      >
        <div className="flex flex-wrap justify-between gap-3">
          <h2 ref={heading} tabIndex={-1}>
            {t("შეზღუდვები და გასაჩივრება", "Restrictions and appeals")}
          </h2>
          <Button variant="ghost" disabled={dirty} onClick={onClose}>
            {t("დახურვა", "Close restrictions")}
          </Button>
        </div>
        <p>
          {t(
            "წერის შეზღუდვა მოქმედებს მხოლოდ შესაბამის არხში. საჩივარს განიხილავს დამოუკიდებელი უფლებამოსილი პირი.",
            "Writing restrictions apply only to the specified channel. Appeals require an independent authorized reviewer.",
          )}
        </p>
        {error && <p role="alert">{error}</p>}
        {notice && <p role="status">{notice}</p>}
        {pending && !busy && (
          <Button onClick={() => void send(pending)}>
            {t("იგივე მოთხოვნის გამეორება", "Retry same request")}
          </Button>
        )}
        {action ? (
          <form onSubmit={submit} className="space-y-3">
            <h3>
              {action.operation === "restrict"
                ? t("წერის დროებითი შეზღუდვა", "Temporarily restrict writing")
                : action.operation === "appeal"
                  ? t("შეზღუდვის გასაჩივრება", "Appeal restriction")
                  : t("საჩივრის განხილვა", "Review appeal")}
            </h3>
            <p>
              {t("მონაწილე", "Participant")} #
              {action.operation === "restrict"
                ? action.target.participantTag
                : action.record.participantTag}
            </p>
            {action.operation !== "restrict" && (
              <>
                <p className="break-words">{action.record.channelTitle}</p>
                <p className="whitespace-pre-wrap break-words">
                  {action.record.reason}
                </p>
                {action.record.appeal && (
                  <p className="whitespace-pre-wrap break-words">
                    {action.record.appeal}
                  </p>
                )}
              </>
            )}
            <fieldset disabled={!!pending || busy} className="space-y-3">
              {action.operation === "restrict" && (
                <Select
                  label={t("შეზღუდვის ვადა", "Restriction duration")}
                  value={hours}
                  onChange={(e) => setHours(e.target.value)}
                  options={[
                    { value: "1", label: t("1 საათი", "1 hour") },
                    { value: "24", label: t("1 დღე", "1 day") },
                    { value: "168", label: t("7 დღე", "7 days") },
                    { value: "720", label: t("30 დღე", "30 days") },
                  ]}
                />
              )}
              {action.operation === "review-appeal" && (
                <Select
                  label={t("გადაწყვეტილება", "Decision")}
                  value={outcome}
                  onChange={(e) => setOutcome(e.target.value)}
                  options={[
                    {
                      value: "lift",
                      label: t("შეზღუდვის მოხსნა", "Lift restriction"),
                    },
                    {
                      value: "uphold",
                      label: t(
                        "შეზღუდვის ძალაში დატოვება",
                        "Uphold restriction",
                      ),
                    },
                  ]}
                />
              )}
              <Textarea
                label={t("დასაბუთება", "Reason")}
                value={reason}
                minLength={10}
                maxLength={1000}
                required
                onChange={(e) => setReason(e.target.value)}
              />
              <p className="text-sm">
                {t(
                  "დასაბუთებას ნახავენ მონაწილე და უფლებამოსილი მოდერატორები. არ ჩაწეროთ ზედმეტი პირადი მონაცემები.",
                  "The affected participant and authorized moderators can read the reason. Include only information needed for this decision.",
                )}
              </p>
              <div className="flex gap-3">
                <Button type="submit" disabled={reason.trim().length < 10}>
                  {t("დადასტურება", "Confirm")}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    setAction(null);
                    setReason("");
                  }}
                >
                  {t("გაუქმება", "Cancel")}
                </Button>
              </div>
            </fieldset>
          </form>
        ) : (
          <>
            {selectedId && (
              <p role="status">
                {t(
                  "შეტყობინებიდან გახსნილი ჩანაწერი",
                  "Record opened from notification",
                )}
              </p>
            )}
            <nav
              className="review-tabs"
              aria-label={t("შეზღუდვების ხედები", "Restriction views")}
            >
              {(["pending", "mine", "history"] as const).map((value) => (
                <button
                  key={value}
                  disabled={dirty}
                  aria-current={
                    !selectedId && view === value ? "page" : undefined
                  }
                  onClick={() => {
                    setSelectedId("");
                    setView(value);
                    setPage(1);
                    setError("");
                  }}
                >
                  {value === "pending"
                    ? t("განსახილველი", "Needs review")
                    : value === "mine"
                      ? t("ჩემი შეზღუდვები", "My restrictions")
                      : t("ისტორია", "Restriction history")}
                </button>
              ))}
            </nav>
            <Button
              variant="secondary"
              disabled={dirty || loading}
              onClick={() => {
                setError("");
                setRevision((v) => v + 1);
              }}
            >
              {t("განახლება", "Refresh restrictions")}
            </Button>
            {loading ? (
              <p role="status">{t("იტვირთება…", "Loading restrictions…")}</p>
            ) : (
              <>
                <p>
                  {t("ჩანაწერები", "Records")}: {total}
                </p>
                {rows.map((r) => (
                  <article
                    key={r.id}
                    className="border border-gray-200 rounded-lg p-4 space-y-2"
                    aria-label={r.channelTitle}
                  >
                    <h3 className="break-words">
                      {r.channelTitle} ·{" "}
                      {r.mine
                        ? t("თქვენ", "You")
                        : t("მონაწილე", "Participant") +
                          " #" +
                          r.participantTag}
                    </h3>
                    <p>
                      {r.active
                        ? t("წერა შეზღუდულია", "Writing restricted")
                        : r.outcome === "lift"
                          ? t("შეზღუდვა მოხსნილია", "Restriction lifted")
                          : t("ვადა გასულია", "Restriction expired")}
                    </p>
                    <p>
                      {t("დაწესდა", "Issued")}: {date(r.createdAt)} ·{" "}
                      {t("ვადა", "Expires")}: {date(r.expiresAt)}
                    </p>
                    <p className="whitespace-pre-wrap break-words">
                      {r.reason}
                    </p>
                    {r.appeal && (
                      <p className="whitespace-pre-wrap break-words">
                        {t("საჩივარი", "Appeal")}: {r.appeal}
                      </p>
                    )}
                    {r.appeal && !r.outcome && (
                      <p>
                        {t(
                          "დამოუკიდებელი განხილვის მოლოდინშია.",
                          "Awaiting independent review.",
                        )}
                      </p>
                    )}
                    {r.outcome && (
                      <p className="whitespace-pre-wrap break-words">
                        {r.outcome === "lift"
                          ? t("მოხსნის დასაბუთება", "Reason for lifting")
                          : t(
                              "ძალაში დატოვების დასაბუთება",
                              "Reason for upholding",
                            )}
                        : {r.reviewReason} · {date(r.reviewedAt!)}
                      </p>
                    )}
                    <div className="flex flex-wrap gap-2">
                      {r.canAppeal && (
                        <Button
                          disabled={dirty}
                          variant="secondary"
                          onClick={() =>
                            begin({ operation: "appeal", record: r })
                          }
                        >
                          {t("შეზღუდვის გასაჩივრება", "Appeal restriction")}
                        </Button>
                      )}
                      {r.canReview && (
                        <Button
                          disabled={dirty}
                          variant="secondary"
                          onClick={() =>
                            begin({ operation: "review-appeal", record: r })
                          }
                        >
                          {t("საჩივრის განხილვა", "Review appeal")}
                        </Button>
                      )}
                    </div>
                  </article>
                ))}
                {!rows.length && !error && (
                  <p>
                    {t(
                      "ამ ხედში ჩანაწერები არ არის.",
                      "No restrictions in this view.",
                    )}
                  </p>
                )}
              </>
            )}
            <div className="flex flex-wrap gap-3">
              <Button
                variant="ghost"
                disabled={dirty || loading || page === 1}
                onClick={() => setPage((p) => p - 1)}
              >
                {t("წინა", "Previous restrictions")}
              </Button>
              <span>{page}</span>
              <Button
                variant="ghost"
                disabled={dirty || loading || page * 25 >= total}
                onClick={() => setPage((p) => p + 1)}
              >
                {t("შემდეგი", "Next restrictions")}
              </Button>
            </div>
          </>
        )}
      </section>
    </Card>
  );
}
