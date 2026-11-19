import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { Link } from "react-router-dom";
import {
  reviewApi,
  type MembershipChange,
  type ReviewStatus,
} from "../api/reviews";
import { authApi } from "../api/client";
import { demoApi } from "../api/demo";
import { apiErrorStatus } from "../api/errors";
import { useAsyncResource } from "./useAsyncResource";
import { useConsolePreferences } from "./useConsolePreferences";
import PositionComparison from "./PositionComparison";
import Button from "./ui/Button";
import Input from "./ui/Input";
import Textarea from "./ui/Textarea";
import Card from "./ui/Card";

export default function PositionRollout({
  organizationId,
  positionId,
  demo,
  close,
}: {
  organizationId: string;
  positionId: string;
  demo: boolean;
  close: () => void;
}) {
  const { language } = useConsolePreferences();
  const t = (ka: string, en: string) => (language === "ka" ? ka : en);
  const [query, setQuery] = useState(""),
    [search, setSearch] = useState(""),
    [page, setPage] = useState(1),
    [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<Record<string, number>>({}),
    [reason, setReason] = useState(""),
    [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState(""),
    [pending, setPending] = useState<MembershipChange[] | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [receipts, setReceipts] = useState<
    { memberId: string; id: string; status: ReviewStatus }[]
  >([]);
  const lock = useRef(false),
    heading = useRef<HTMLHeadingElement>(null);
  const load = useCallback(
    () => reviewApi.revisionOptions(organizationId, positionId, search, page),
    [organizationId, positionId, search, page],
  );
  const resource = useAsyncResource(
      JSON.stringify([organizationId, positionId, search, page, revision]),
      load,
    ),
    data = resource.data;
  const chosen =
    data?.items.filter((m) => selected[m.id] === m.version && !m.blocker) ?? [];
  const intent = data
    ? JSON.stringify([
        data.definitionKey,
        chosen.map((m) => [m.id, m.version]),
        reason,
      ])
    : "";
  const confirmed =
    !!intent &&
    confirmation === intent &&
    chosen.length > 0 &&
    chosen.length <= 20 &&
    chosen.length === Object.keys(selected).length;
  const locked = busy || !!pending;
  const reset = () => {
    setSelected({});
    setConfirmation("");
  };
  useEffect(() => {
    heading.current?.focus();
    const refresh = () => setRevision((v) => v + 1);
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);
  const dirty = locked || Object.keys(selected).length > 0;
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const state = (value: string) =>
    ({
      active: t("მოქმედი", "Active"),
      suspended: t("შეჩერებული", "Suspended"),
      scheduled: t("დაგეგმილი", "Scheduled"),
      ended: t("დასრულებული", "Ended"),
      expired: t("ვადაგასული", "Expired"),
      pending: t("დასამტკიცებელი", "Pending approval"),
      approved: t("დამტკიცებული", "Approved"),
      rejected: t("უარყოფილი", "Rejected"),
    })[value] ?? value;
  const blocker = (value: string) =>
    ({
      inactive: t(
        "ეს წევრობა გადაყვანისთვის აღარ არის ხელმისაწვდომი",
        "This membership is no longer eligible for adoption",
      ),
      responsibilities: t(
        "ჯერ მოაგვარეთ მიმდინარე დავალებები",
        "Resolve active responsibilities first",
      ),
      overlap: t(
        "ახალი პოზიციის წევრობა უკვე არსებობს",
        "Destination membership already exists",
      ),
      pending: t(
        "წევრობაზე უკვე არის მიმდინარე მოთხოვნა",
        "A membership change is already pending",
      ),
      self: t(
        "საკუთარი წევრობის შეცვლა დაუშვებელია",
        "You cannot change your own membership",
      ),
      definition: t(
        "პოზიცია გამოყენებიდან ამოღებულია",
        "A position definition is retired",
      ),
      authority: t(
        "საჭირო უფლებები არ გაქვთ",
        "Required authority is unavailable",
      ),
    })[value] ?? t("ამჟამად მიუწვდომელია", "Currently unavailable");
  async function send(queue: MembershipChange[]) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setPending(queue);
    let remaining = queue;
    try {
      if (demo) await demoApi.stepUp();
      else await authApi.stepUp(password);
      while (remaining.length) {
        const item = remaining[0],
          response = await reviewApi.change(item);
        setReceipts((old) => [
          ...old.filter((r) => r.memberId !== item.membershipId),
          { memberId: item.membershipId, ...response },
        ]);
        remaining = remaining.slice(1);
        setPending(remaining.length ? remaining : null);
        window.dispatchEvent(new Event("ertad-reviews-changed"));
      }
      reset();
      setPassword("");
      setRevision((v) => v + 1);
    } catch (e) {
      const status = apiErrorStatus(e);
      if (status && status >= 400 && status < 500) {
        setPending(null);
        reset();
        resource.clear();
        setRevision((v) => v + 1);
        setError(
          t(
            "გაგზავნა შეჩერდა: მონაცემები ან წვდომა შეიცვალა. დადასტურებული მოთხოვნები შენარჩუნებულია; გადაამოწმეთ დარჩენილი წევრები.",
            "Submission stopped: data or access changed. Confirmed requests remain saved; review the remaining members.",
          ),
        );
      } else {
        setPending(remaining);
        setError(
          t(
            "მიმდინარე მოთხოვნის შედეგი გაურკვეველია. გაიმეორეთ იგივე მოთხოვნები; დადასტურებული ჩანაწერები აღარ გაიგზავნება.",
            "The current outcome is uncertain. Retry the same requests; confirmed entries will not be sent again.",
          ),
        );
      }
    } finally {
      setBusy(false);
      lock.current = false;
    }
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!data || !confirmed || locked || reason.trim().length < 10) return;
    const expiresAt = new Date(Date.now() + 86400000).toISOString();
    void send(
      chosen.map((m) => ({
        organizationId,
        positionId,
        membershipId: m.id,
        version: m.version,
        kind: "revision",
        definitionKey: data.definitionKey,
        key: crypto.randomUUID(),
        expiresAt,
        reason: reason.trim(),
      })),
    );
  }
  return (
    <Card>
      <h2 ref={heading} tabIndex={-1} className="text-xl font-semibold">
        {t("წევრების გადაყვანა ახალ ვერსიაზე", "Adopt position revision")}
      </h2>
      <p className="my-3">
        {t(
          "თითოეული წევრისთვის შეიქმნება ცალკე მოთხოვნა და საჭირო იქნება სხვა ადმინისტრატორის დამტკიცება. თავდაპირველი ვადა, შეჩერებული სტატუსი, ქულები და ისტორია შენარჩუნდება. აირჩიეთ მაქსიმუმ 20 წევრი მიმდინარე გვერდიდან.",
          "Each member receives a separate request requiring another administrator’s approval. Original expiry, suspended status, points and history are preserved. Select up to 20 members on this page.",
        )}
      </p>
      {error && <p role="alert">{error}</p>}
      {receipts.length > 0 && (
        <p role="status">
          {t("დადასტურებულად შენახული მოთხოვნები", "Confirmed saved requests")}:{" "}
          {receipts.length}.{" "}
          <Link className="underline" to="/reviews">
            {t("მოთხოვნების ნახვა", "View requests")}
          </Link>
        </p>
      )}
      {resource.failed && (
        <p role="alert">
          {t(
            "მონაცემები ან წვდომა მიუწვდომელია.",
            "Data or access is unavailable.",
          )}
        </p>
      )}
      {resource.loading && <p role="status">{t("იტვირთება…", "Loading…")}</p>}
      <Button
        variant="secondary"
        disabled={locked}
        onClick={() => {
          reset();
          setRevision((v) => v + 1);
        }}
      >
        {t("განახლება", "Refresh")}
      </Button>
      {data && (
        <>
          <div className="my-4">
            <PositionComparison comparison={data.comparison} />
          </div>
          <form
            className="flex flex-wrap items-end gap-3 mb-4"
            onSubmit={(e) => {
              e.preventDefault();
              reset();
              setSearch(query.trim());
              setPage(1);
            }}
          >
            <Input
              label={t(
                "სახელი ან წევრის სრული კოდი",
                "Name or full member code",
              )}
              value={query}
              maxLength={120}
              disabled={locked}
              onChange={(e) => setQuery(e.target.value)}
            />
            <Button type="submit" variant="secondary" disabled={locked}>
              {t("ძებნა", "Search")}
            </Button>
          </form>
          <form onSubmit={submit}>
            <fieldset disabled={locked} className="space-y-4">
              <legend>
                {t("წევრების რაოდენობა", "Members found")}: {data.total}
              </legend>
              {!data.items.length && (
                <p>{t("წევრები ვერ მოიძებნა.", "No members found.")}</p>
              )}
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead>
                    <tr>
                      <th className="p-2">{t("წევრი", "Member")}</th>
                      <th className="p-2">
                        {t(
                          "წინა პოზიციაზე წევრობა / ვადა",
                          "Previous position membership / expiry",
                        )}
                      </th>
                      <th className="p-2">{t("მდგომარეობა", "Progress")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((m) => (
                      <tr key={m.id}>
                        <td className="p-2">
                          <label className="flex gap-2 items-center min-h-11">
                            <input
                              type="checkbox"
                              disabled={
                                !!m.blocker ||
                                (chosen.length >= 20 &&
                                  selected[m.id] !== m.version)
                              }
                              checked={
                                selected[m.id] === m.version && !m.blocker
                              }
                              onChange={(e) => {
                                setSelected((old) => {
                                  const next = { ...old };
                                  if (e.target.checked) next[m.id] = m.version;
                                  else delete next[m.id];
                                  return next;
                                });
                                setConfirmation("");
                              }}
                            />
                            <span className="break-all">
                              {m.displayName ?? m.memberId}
                            </span>
                          </label>
                        </td>
                        <td className="p-2">
                          {state(m.state)}
                          <br />
                          {m.validUntil
                            ? new Date(m.validUntil).toLocaleString(
                                language === "ka" ? "ka-GE" : "en-GB",
                                { hour12: false },
                              )
                            : t("უვადო", "No expiry")}
                        </td>
                        <td className="p-2">
                          {m.review && <p>{state(m.review.status)}</p>}
                          {m.blocker && <p>{blocker(m.blocker)}</p>}
                          {!m.blocker && (
                            <p>
                              {t(
                                "შესაძლებელია შერჩევა",
                                "Available for selection",
                              )}
                            </p>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center gap-3">
                <Button
                  variant="secondary"
                  disabled={page === 1}
                  onClick={() => {
                    reset();
                    setPage((v) => v - 1);
                  }}
                >
                  {t("წინა", "Previous")}
                </Button>
                <span>{page}</span>
                <Button
                  variant="secondary"
                  disabled={page * 25 >= data.total}
                  onClick={() => {
                    reset();
                    setPage((v) => v + 1);
                  }}
                >
                  {t("შემდეგი", "Next")}
                </Button>
              </div>
              <Textarea
                label={t(
                  "მიზეზი (10–1000 სიმბოლო)",
                  "Reason (10–1000 characters)",
                )}
                required
                minLength={10}
                maxLength={1000}
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value);
                  setConfirmation("");
                }}
              />
              <label className="flex gap-2 items-center min-h-11">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) =>
                    setConfirmation(e.target.checked ? intent : "")
                  }
                />
                {t(
                  "გადავამოწმე უფლებები და ვადასტურებ არჩეული წევრების გადაყვანის მოთხოვნებს.",
                  "I reviewed the permissions and confirm the selected membership requests.",
                )}
              </label>
              {!demo && (
                <Input
                  label={t("პაროლი", "Password")}
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              )}
              <Button
                type="submit"
                disabled={!confirmed || reason.trim().length < 10}
              >
                {t("მოთხოვნების გაგზავნა", "Submit requests")} ({chosen.length})
              </Button>
            </fieldset>
          </form>
        </>
      )}
      {pending && !busy && (
        <Button className="mt-3" onClick={() => void send(pending)}>
          {t("იგივე მოთხოვნების გამეორება", "Retry same requests")}
        </Button>
      )}
      <Button
        className="mt-3"
        variant="secondary"
        disabled={locked}
        onClick={() => {
          if (
            !dirty ||
            window.confirm(
              t(
                "გაუქმდეს შეუნახავი შერჩევა?",
                "Discard the unsaved selection?",
              ),
            )
          )
            close();
        }}
      >
        {t("დახურვა", "Close")}
      </Button>
    </Card>
  );
}
