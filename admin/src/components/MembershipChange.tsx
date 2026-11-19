import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { Link } from "react-router-dom";
import { reviewApi, type MembershipChange as Change } from "../api/reviews";
import { apiErrorStatus } from "../api/errors";
import { authApi } from "../api/client";
import { demoApi } from "../api/demo";
import { useAsyncResource } from "./useAsyncResource";
import { useConsolePreferences } from "./useConsolePreferences";
import Button from "./ui/Button";
import Input from "./ui/Input";
import Select from "./ui/Select";
import Textarea from "./ui/Textarea";

export default function MembershipChange({
  organizationId,
  membershipId,
}: {
  organizationId: string;
  membershipId: string;
}) {
  const [open, setOpen] = useState(false);
  const { language } = useConsolePreferences();
  return open ? (
    <ChangeForm
      key={organizationId + membershipId}
      organizationId={organizationId}
      membershipId={membershipId}
      close={() => setOpen(false)}
    />
  ) : (
    <Button variant="secondary" onClick={() => setOpen(true)}>
      {language === "ka" ? "წევრობის მართვა" : "Manage membership"}
    </Button>
  );
}

function ChangeForm({
  organizationId,
  membershipId,
  close,
}: {
  organizationId: string;
  membershipId: string;
  close: () => void;
}) {
  const { language } = useConsolePreferences(),
    t = (ka: string, en: string) => (language === "ka" ? ka : en);
  const [revision, setRevision] = useState(0),
    [kind, setKind] = useState<Change["kind"]>("transfer"),
    [positionId, setPositionId] = useState(""),
    [until, setUntil] = useState(""),
    [reason, setReason] = useState(""),
    [confirmedVersion, setConfirmedVersion] = useState<number | null>(null),
    [password, setPassword] = useState(""),
    [demo, setDemo] = useState(false),
    [busy, setBusy] = useState(false),
    [pending, setPending] = useState<Change | null>(null),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(false);
  const lock = useRef(false),
    title = useRef<HTMLHeadingElement>(null);
  const load = useCallback(
    () => reviewApi.changeOptions(organizationId, membershipId),
    [organizationId, membershipId],
  );
  const resource = useAsyncResource(
      JSON.stringify([organizationId, membershipId, revision]),
      load,
    ),
    data = resource.data;
  const allowed =
    !!data &&
    (kind === "transfer"
      ? data.active && !data.blocked
      : kind === "revoke"
        ? data.canRevoke
        : kind === "suspend"
          ? data.canSuspend
          : kind === "resume" && data.canResume);
  const confirmed = confirmedVersion !== null && confirmedVersion === data?.version;
  useEffect(() => {
    title.current?.focus();
    let live = true;
    if (import.meta.env.DEV)
      void demoApi
        .scenario()
        .then(() => {
          if (live) setDemo(true);
        })
        .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    const refresh = () => setRevision((v) => v + 1);
    const timer = window.setInterval(refresh, 60000);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, []);
  const dirty = !saved && (!!reason || !!pending || busy);
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
  async function send(input: Change) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setPending(input);
    try {
      if (demo) await demoApi.stepUp();
      else await authApi.stepUp(password);
      await reviewApi.change(input);
      setPending(null);
      setSaved(true);
      setPassword("");
      window.dispatchEvent(new Event("ertad-reviews-changed"));
    } catch (e) {
      const status = apiErrorStatus(e);
      if (status && status >= 400 && status < 500) {
        setPending(null);
        resource.clear();
        setRevision((v) => v + 1);
      }
      setError(
        status === 403
          ? t("წვდომა აღარ გაქვთ.", "Access is no longer available.")
          : status === 409
            ? t(
                "წევრობა ან პასუხისმგებლობები შეიცვალა. გადაამოწმეთ მონაცემები.",
                "Membership or responsibilities changed. Review the current data.",
              )
            : t(
                "შედეგი ვერ დადასტურდა. გაიმეორეთ იგივე მოთხოვნა.",
                "The outcome could not be confirmed. Retry the same request.",
              ),
      );
    } finally {
      setBusy(false);
      lock.current = false;
    }
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!data || pending || !confirmed || !allowed) return;
    const validity = new Date(until);
    if (
      kind === "transfer" &&
      (!positionId ||
        !Number.isFinite(validity.getTime()) ||
        validity.getTime() <= Date.now() + 86400000)
    ) {
      setError(
        t(
          "შეარჩიეთ პოზიცია და ერთ დღეზე მეტი მოქმედების ვადა.",
          "Choose a position and a validity longer than one day.",
        ),
      );
      return;
    }
    void send({
      organizationId,
      membershipId,
      version: data.version,
      key: crypto.randomUUID(),
      kind,
      reason: reason.trim(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      ...(kind === "transfer"
        ? { positionId, validUntil: validity.toISOString() }
        : {}),
    });
  }
  return (
    <section
      className="mt-3 space-y-3 rounded-lg border border-[var(--border)] p-4"
      aria-label={t("წევრობის ცვლილება", "Membership change")}
    >
      <h3 ref={title} tabIndex={-1} className="font-semibold">
        {t("წევრობის ცვლილება", "Membership change")}
      </h3>
      <p>
        {t(
          "იცვლება მხოლოდ ეს წევრობა. ქულები და ისტორია შენარჩუნდება. მოთხოვნას 24 საათში სხვა უფლებამოსილი ადმინისტრატორი ამტკიცებს.",
          "Only this membership changes. Points and history are preserved. Another authorized administrator must decide within 24 hours.",
        )}
      </p>
      {error && <p role="alert">{error}</p>}
      {saved ? (
        <p role="status">
          {t(
            "მოთხოვნა გაგზავნილია; წევრობა დამტკიცებამდე უცვლელია.",
            "Request submitted; membership remains unchanged until approval.",
          )}{" "}
          <Link to="/reviews?view=mine">
            {t("ჩემი მოთხოვნები", "My requests")}
          </Link>
        </p>
      ) : (
        <>
          {resource.loading && (
            <p role="status">{t("იტვირთება…", "Loading…")}</p>
          )}
          {resource.failed && (
            <p role="alert">
              {t(
                "მონაცემები ვერ ჩაიტვირთა.",
                "Could not load membership options.",
              )}{" "}
              <Button onClick={() => setRevision((v) => v + 1)}>
                {t("ხელახლა", "Retry")}
              </Button>
            </p>
          )}
          {data && (
            <form onSubmit={submit} className="space-y-3">
              <p>
                {data.unitName} · {data.positionName}
              </p>
              {data.blocked && (kind === "transfer" || kind === "revoke") && (
                <p role="status">
                  {t(
                    "მიმდინარე დავალებები ცვლილებას ბლოკავს. ჯერ დაასრულეთ ან მოაგვარეთ მონაწილეობა.",
                    "Active task responsibilities block this change. Complete or resolve participation first.",
                  )}
                </p>
              )}
              {!data.active &&
                !data.canSuspend &&
                !data.canResume &&
                !data.canRevoke && (
                  <p role="status">
                    {t(
                      "ეს წევრობა აღარ არის მოქმედი.",
                      "This membership is no longer active.",
                    )}
                  </p>
                )}
              <fieldset disabled={busy || !!pending} className="space-y-3">
                <Select
                  label={t("მოქმედება", "Action")}
                  value={
                    data.active ||
                    (kind === "revoke" && data.canRevoke) ||
                    (kind === "suspend" && data.canSuspend) ||
                    (kind === "resume" && data.canResume)
                      ? kind
                      : ""
                  }
                  onChange={(e) => {
                    setKind(e.target.value as Change["kind"]);
                    setConfirmedVersion(null);
                  }}
                  options={[
                    {
                      value: "",
                      label: t("აირჩიეთ მოქმედება", "Choose an action"),
                    },
                    ...(data.active
                      ? [
                          {
                            value: "transfer",
                            label: t(
                              "გადაყვანა / პოზიციის შეცვლა",
                              "Transfer / change position",
                            ),
                          },
                        ]
                      : []),
                    ...(data.active || data.canRevoke
                      ? [
                          {
                            value: "revoke",
                            label: t(
                              "ამ წევრობის შეწყვეტა",
                              "End this membership",
                            ),
                          },
                        ]
                      : []),
                    ...(data.canSuspend
                      ? [
                          {
                            value: "suspend",
                            label: t(
                              "ამ წევრობის შეჩერება",
                              "Suspend this membership",
                            ),
                          },
                        ]
                      : []),
                    ...(data.canResume
                      ? [
                          {
                            value: "resume",
                            label: t(
                              "ამ წევრობის აღდგენა",
                              "Resume this membership",
                            ),
                          },
                        ]
                      : []),
                  ]}
                />
                {(kind === "suspend" || kind === "resume") && (
                  <p>
                    {t(
                      "იცვლება მხოლოდ ამ წევრობის წვდომა. ძველი პოზიცია და ვადა უცვლელია; მიმდინარე დავალებები და ისტორია შენარჩუნდება. შეჩერება არ არის ანგარიშის სრული ბლოკირება.",
                      "Only this membership's access changes. Its original position and expiry, existing assignments and history are preserved. Suspension does not disable the entire account.",
                    )}
                    {data.validUntil && (
                      <>
                        {" "}
                        {t("ბოლო ვადა:", "Expires:")}{" "}
                        {new Date(data.validUntil).toLocaleString(
                          language === "ka" ? "ka-GE" : "en-GB",
                          { hour12: false },
                        )}
                      </>
                    )}
                  </p>
                )}
                {kind === "transfer" && data.active && (
                  <>
                    <Select
                      label={t("ახალი პოზიცია", "Destination position")}
                      value={positionId}
                      onChange={(e) => {
                        setPositionId(e.target.value);
                        setConfirmedVersion(null);
                      }}
                      required
                      options={[
                        {
                          value: "",
                          label: t("აირჩიეთ პოზიცია", "Choose a position"),
                        },
                        ...data.destinations.map((p) => ({
                          value: p.id,
                          label: p.unitName + " / " + p.name,
                        })),
                      ]}
                    />
                    <Input
                      label={t(
                        "ახალი წევრობის ბოლო ვადა",
                        "New membership valid until",
                      )}
                      type="datetime-local"
                      required
                      value={until}
                      onChange={(e) => {
                        setUntil(e.target.value);
                        setConfirmedVersion(null);
                      }}
                    />
                    {data.validUntil && (
                      <p>
                        {t(
                          "ვადა ვერ გადააჭარბებს არსებულს:",
                          "Validity cannot exceed the existing expiry:",
                        )}{" "}
                        {new Date(data.validUntil).toLocaleString(
                          language === "ka" ? "ka-GE" : "en-GB",
                          { hour12: false },
                        )}
                      </p>
                    )}
                  </>
                )}
                <Textarea
                  label={t(
                    "მიზეზი (10–1000 სიმბოლო)",
                    "Reason (10–1000 characters)",
                  )}
                  value={reason}
                  onChange={(e) => {
                    setReason(e.target.value);
                    setConfirmedVersion(null);
                  }}
                  minLength={10}
                  maxLength={1000}
                  required
                />
                <label className="review-confirm">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(e) => setConfirmedVersion(e.target.checked ? data.version : null)}
                  />
                  {t(
                    "ვადასტურებ არჩეული წევრობის შეცვლის მოთხოვნას.",
                    "I confirm the requested change to this membership.",
                  )}
                </label>
                {!demo && (
                  <Input
                    label={t("პაროლი", "Password")}
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                )}
                <Button
                  type="submit"
                  disabled={!allowed || !confirmed || reason.trim().length < 10}
                >
                  {t("მოთხოვნის გაგზავნა", "Submit request")}
                </Button>
              </fieldset>
            </form>
          )}
          {pending && !busy && (
            <Button onClick={() => void send(pending)}>
              {t("იგივე მოთხოვნის გამეორება", "Retry same request")}
            </Button>
          )}
        </>
      )}
      <Button
        variant="secondary"
        disabled={busy || !!pending}
        onClick={() => {
          if (
            !dirty ||
            window.confirm(
              t("გაუქმდეს შეუნახავი ცვლილება?", "Discard the unsaved change?"),
            )
          )
            close();
        }}
      >
        {t("დახურვა", "Close")}
      </Button>
    </section>
  );
}
