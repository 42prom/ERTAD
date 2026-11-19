import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  accountSecurityApi,
  type HoldReason,
  type LifecycleAction,
  type LifecycleProposal,
  type LifecycleReason,
  type SecurityAccount,
} from "../api/accountSecurity";
import { authApi } from "../api/client";
import { useConsolePreferences } from "./useConsolePreferences";
import { useAsyncResource } from "./useAsyncResource";
import Card from "./ui/Card";
import Button from "./ui/Button";
import Select from "./ui/Select";
import Input from "./ui/Input";

type Selection =
  | {
      account: SecurityAccount;
      kind: "hold";
      scope: string;
      requestId: string;
    }
  | {
      account: SecurityAccount;
      kind: "release";
      scope: string;
      requestId: string;
    }
  | {
      account: SecurityAccount;
      kind: "propose";
      action: LifecycleAction;
      scope: string;
      requestId: string;
    }
  | {
      proposal: LifecycleProposal;
      kind: "review";
      decision: "approve" | "reject" | "withdraw";
      scope: string;
      requestId: string;
    };

const DEFAULT_LIFECYCLE_REASON: Record<LifecycleAction, LifecycleReason> = {
  disable_account: "policy_violation",
  restore_account: "account_restoration",
  lost_contact_recovery: "lost_contact",
  mfa_reset: "lost_mfa_device",
};

export default function PlatformAccounts({
  canHold,
  canRelease,
  canPropose = false,
  canApprove = false,
  refreshRevision = 0,
}: {
  canHold: boolean;
  canRelease: boolean;
  canPropose?: boolean;
  canApprove?: boolean;
  refreshRevision?: number;
}) {
  const { language } = useConsolePreferences();
  const t = (ka: string, en: string) => (language === "ka" ? ka : en);

  const [state, setState] = useState("all");
  const [cursors, setCursors] = useState<string[]>([]);
  const [revision, setRevision] = useState(0);
  const [reference, setReference] = useState(
    () => new URLSearchParams(window.location.search).get("account") ?? "",
  );
  const [referenceInput, setReferenceInput] = useState(reference);
  const cursor = cursors[cursors.length - 1];
  const load = useCallback(
    () => accountSecurityApi.list(state, cursor, reference || undefined),
    [state, cursor, reference],
  );
  const resource = useAsyncResource(
    JSON.stringify([
      state,
      cursor,
      reference,
      revision,
      refreshRevision,
      language,
    ]),
    load,
  );
  const scope = JSON.stringify([
    state,
    cursor,
    reference,
    refreshRevision,
    language,
  ]);

  const [selection, setSelection] = useState<Selection | null>(null);
  const [reason, setReason] = useState<HoldReason>("suspected_compromise");
  const [lifecycleReason, setLifecycleReason] = useState<LifecycleReason>(
    "policy_violation",
  );
  const [newEmail, setNewEmail] = useState("");
  const [password, setPassword] = useState("");
  const [intent, setIntent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const lock = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!selection) return;
    const el = dialog.current;
    el?.showModal();
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      el?.close();
      document.body.style.overflow = previous;
      trigger.current?.focus();
    };
  }, [selection]);

  const close = () => {
    if (lock.current) return;
    setSelection(null);
    setPassword("");
    setNewEmail("");
    setIntent(false);
  };

  const current =
    selection && "account" in selection
      ? resource.data?.items.find((a) => a.id === selection.account.id)
      : undefined;
  const currentProposal =
    selection && selection.kind === "review"
      ? resource.data?.proposals?.find((p) => p.id === selection.proposal.id)
      : undefined;

  const sameHoldOrAccount =
    selection &&
    "account" in selection &&
    selection.scope === scope &&
    !!current &&
    current.hold?.id === selection.account.hold?.id &&
    current.active === selection.account.active;

  const allowed = (() => {
    if (!selection || selection.scope !== scope) return false;
    if (selection.kind === "hold") {
      return (
        !!sameHoldOrAccount &&
        canHold &&
        current!.active &&
        current!.recoverable &&
        !current!.hold
      );
    }
    if (selection.kind === "release") {
      return (
        !!sameHoldOrAccount &&
        canRelease &&
        current!.active &&
        !!current!.hold &&
        !current!.hold.own &&
        current!.hold.credentialChanged
      );
    }
    if (selection.kind === "propose") {
      if (!sameHoldOrAccount || !canPropose) return false;
      if (current!.pendingProposals?.some((p) => p.action === selection.action)) {
        return false;
      }
      if (selection.action === "disable_account") return current!.active;
      if (selection.action === "restore_account") return !current!.active;
      if (selection.action === "lost_contact_recovery") {
        return current!.active && !!current!.lostContactEligible;
      }
      return (
        current!.active &&
        !!(current!.mfaEnabled || current!.mfaProvisioned)
      );
    }
    if (!currentProposal || currentProposal.status !== "pending") return false;
    if (selection.decision === "withdraw") {
      return canPropose && currentProposal.mine;
    }
    return canApprove && !currentProposal.mine;
  })();

  const date = (value: string) =>
    new Date(value).toLocaleString(language === "ka" ? "ka-GE" : "en-GB", {
      hour12: false,
    });

  function chooseHold(
    account: SecurityAccount,
    kind: "hold" | "release",
    button: HTMLElement,
  ) {
    trigger.current = button;
    setSelection({ account, kind, scope, requestId: crypto.randomUUID() });
    setPassword("");
    setNewEmail("");
    setIntent(false);
    setReason("suspected_compromise");
    setError("");
    setNotice("");
  }

  function choosePropose(
    account: SecurityAccount,
    action: LifecycleAction,
    button: HTMLElement,
  ) {
    trigger.current = button;
    setSelection({
      account,
      kind: "propose",
      action,
      scope,
      requestId: crypto.randomUUID(),
    });
    setLifecycleReason(DEFAULT_LIFECYCLE_REASON[action]);
    setNewEmail("");
    setPassword("");
    setIntent(false);
    setError("");
    setNotice("");
  }

  function chooseReview(
    proposal: LifecycleProposal,
    decision: "approve" | "reject" | "withdraw",
    button: HTMLElement,
  ) {
    trigger.current = button;
    setSelection({
      proposal,
      kind: "review",
      decision,
      scope,
      requestId: crypto.randomUUID(),
    });
    setNewEmail("");
    setPassword("");
    setIntent(false);
    setError("");
    setNotice("");
  }

  const normalizedNewEmail = newEmail.trim().toLowerCase();
  const needsNewEmail =
    selection?.kind === "propose" &&
    selection.action === "lost_contact_recovery";
  const emailValid =
    !needsNewEmail ||
    (normalizedNewEmail.length <= 254 &&
      /^[a-z0-9._%+-]+@[a-z0-9.-]+[.][a-z]{2,}$/.test(normalizedNewEmail));

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (
      lock.current ||
      !selection ||
      !allowed ||
      !password ||
      !intent ||
      !emailValid
    ) {
      return;
    }
    lock.current = true;
    setBusy(true);
    setError("");
    let started = false;
    try {
      await authApi.stepUp(password);
      setPassword("");
      started = true;
      if (selection.kind === "hold") {
        await accountSecurityApi.hold(
          selection.account.id,
          selection.requestId,
          reason,
        );
      } else if (selection.kind === "release") {
        await accountSecurityApi.release(
          selection.account.hold!.id,
          selection.requestId,
        );
      } else if (selection.kind === "propose") {
        await accountSecurityApi.proposeLifecycle({
          accountId: selection.account.id,
          requestId: selection.requestId,
          action: selection.action,
          reason: lifecycleReason,
          ...(needsNewEmail ? { newEmail: normalizedNewEmail } : {}),
        });
      } else {
        await accountSecurityApi.reviewLifecycle(
          selection.proposal.id,
          selection.requestId,
          selection.decision,
        );
      }
      setNotice(
        t(
          "ცვლილება შენახულია. ორგანიზაციული უფლებები უცვლელია.",
          "Change saved. Organizational permissions are unchanged.",
        ),
      );
    } catch {
      setError(
        started
          ? t(
              "შედეგი ვერ დადასტურდა. გადაამოწმეთ განახლებული მდგომარეობა; მოქმედება ავტომატურად არ განმეორდება.",
              "The outcome is unconfirmed. Check the refreshed state; this action will not retry automatically.",
            )
          : t(
              "პაროლის დადასტურება ვერ მოხერხდა. მოქმედება არ გაგზავნილა.",
              "Password confirmation failed. No action was sent.",
            ),
      );
    } finally {
      setSelection(null);
      setPassword("");
      setNewEmail("");
      setIntent(false);
      setBusy(false);
      lock.current = false;
      resource.clear();
      setRevision((v) => v + 1);
    }
  }

  const actionLabel = (action: LifecycleAction) =>
    ({
      disable_account: t("ანგარიშის გამორთვა", "Disable account"),
      restore_account: t("ანგარიშის აღდგენა", "Restore account"),
      lost_contact_recovery: t(
        "დაკარგული კონტაქტის აღდგენა",
        "Lost-contact recovery",
      ),
      mfa_reset: t("MFA-ს გადაყენება", "Reset MFA"),
    })[action];

  const reasonLabel = (value: LifecycleReason) =>
    ({
      policy_violation: t("წესების დარღვევა", "Policy violation"),
      departure: t("წევრობის/უფლებამოსილების დასრულება", "Departure"),
      account_restoration: t("ანგარიშის აღდგენა", "Account restoration"),
      lost_contact: t("დაკარგული წვდომა ელფოსტაზე", "Lost contact access"),
      lost_mfa_device: t("დაკარგული MFA მოწყობილობა", "Lost MFA device"),
      mfa_compromise: t("MFA კომპრომეტირება", "MFA compromise"),
    })[value];

  const statusLabel = (status: LifecycleProposal["status"]) =>
    ({
      pending: t("განიხილება", "Pending review"),
      approved: t("დამტკიცებულია", "Approved"),
      rejected: t("უარყოფილია", "Rejected"),
      withdrawn: t("გაწვეულია", "Withdrawn"),
      expired: t("ვადაგასულია", "Expired"),
    })[status];

  const proposals = resource.data?.proposals ?? [];

  return (
    <Card>
      <h2>{t("ვებ-ანგარიშების დაცვა", "Web account protection")}</h2>
      <p>
        {t(
          "ტექნიკური შეჩერება დახურავს ყველა ვებ-სესიას და დაბლოკავს ახალ შესვლას. წევრობა და რეგიონული უფლებები უცვლელი რჩება. მოხსნას სხვა ტექნიკური მენეჯერი და მფლობელის მიერ პაროლის შეცვლა სჭირდება.",
          "A security hold closes all web sessions and blocks new sign-ins. Memberships and regional permissions remain unchanged. Release requires another technical manager and the owner to change their password.",
        )}
      </p>
      <p>
        {t(
          "ანგარიშის გამორთვა/აღდგენა, დაკარგული კონტაქტის შეცვლა და MFA-ს გადაყენება ორეტაპიანი დამოუკიდებელი ტექნიკური განხილვით სრულდება და არ ქმნის ორგანიზაციულ უფლებებს.",
          "Account-wide disable/restore, lost-contact recovery, and MFA reset require independent two-person technical approval and grant no organizational authority.",
        )}
      </p>

      <form
        className="flex flex-wrap items-end gap-3 my-4"
        onSubmit={(e) => {
          e.preventDefault();
          setReference(referenceInput.trim());
          setCursors([]);
        }}
      >
        <Input
          label={t("ანგარიშის ზუსტი კოდი", "Exact account reference")}
          value={referenceInput}
          maxLength={36}
          pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
          disabled={busy}
          onChange={(e) => setReferenceInput(e.target.value)}
        />
        <Button type="submit" variant="secondary" disabled={busy}>
          {t("ძებნა", "Find account")}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={busy}
          onClick={() => {
            setReference("");
            setReferenceInput("");
            setCursors([]);
          }}
        >
          {t("გასუფთავება", "Clear reference")}
        </Button>
      </form>

      <div className="flex flex-wrap items-end gap-3 my-4">
        <Select
          label={t("წვდომის მდგომარეობა", "Access state")}
          value={state}
          disabled={busy}
          onChange={(e) => {
            setState(e.target.value);
            setCursors([]);
          }}
          options={[
            { value: "all", label: t("ყველა", "All") },
            { value: "held", label: t("შეჩერებული", "Held") },
            {
              value: "available",
              label: t("შეზღუდვის გარეშე", "Without a hold"),
            },
            { value: "disabled", label: t("გამორთული", "Disabled") },
            {
              value: "pending_review",
              label: t("განხილვის მოლოდინში", "Pending review"),
            },
          ]}
        />
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => setRevision((v) => v + 1)}
        >
          {t("განახლება", "Refresh accounts")}
        </Button>
      </div>

      {resource.loading && <p role="status">{t("იტვირთება…", "Loading…")}</p>}
      {resource.failed && (
        <p role="alert">
          {t(
            "ანგარიშები ვერ ჩაიტვირთა ან წვდომა აღარ გაქვთ.",
            "Accounts could not load or access is unavailable.",
          )}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}

      {resource.data && (
        <>
          {!resource.data.items.length ? (
            <p>
              {t(
                "ამ ფილტრით ანგარიშები არ მოიძებნა.",
                "No accounts match this filter.",
              )}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="review-table">
                <thead>
                  <tr>
                    <th>{t("ანგარიშის კოდი", "Account reference")}</th>
                    <th>{t("მდგომარეობა", "State")}</th>
                    <th>{t("აღდგენა და MFA", "Recovery & MFA")}</th>
                    <th>{t("მოქმედება", "Action")}</th>
                  </tr>
                </thead>
                <tbody>
                  {resource.data.items.map((account) => {
                    const hasPending = (targetAction: LifecycleAction) =>
                      account.pendingProposals?.some(
                        (p) => p.action === targetAction,
                      ) ?? false;
                    return (
                      <tr key={account.id}>
                        <td className="break-all">{account.id}</td>
                        <td>
                          {account.hold ? (
                            <>
                              {t("შეჩერებულია", "Held")} ·{" "}
                              {date(account.hold.heldAt)}
                            </>
                          ) : account.active ? (
                            t("შეზღუდვის გარეშე", "Without a hold")
                          ) : (
                            t("ანგარიში გამორთულია", "Account disabled")
                          )}
                          {(account.pendingProposals?.length ?? 0) > 0 && (
                            <div className="text-xs opacity-80 mt-1">
                              {t("მოლოდინშია:", "Pending:")}{" "}
                              {account.pendingProposals!
                                .map((p) => actionLabel(p.action))
                                .join(", ")}
                            </div>
                          )}
                        </td>
                        <td>
                          <div>
                            {account.hold
                              ? account.hold.credentialChanged
                                ? t("პაროლი შეცვლილია", "Password changed")
                                : t(
                                    "საჭიროა პაროლის შეცვლა",
                                    "Password change required",
                                  )
                              : account.recoverable
                                ? t("ხელმისაწვდომია", "Available")
                                : t(
                                    "საჭიროა ცალკე პროცედურა",
                                    "Separate procedure required",
                                  )}
                          </div>
                          {(account.mfaEnabled || account.mfaProvisioned) && (
                            <div className="text-xs opacity-80 mt-1">
                              {account.mfaEnabled
                                ? t("MFA ჩართულია", "MFA enabled")
                                : t("MFA მომზადებულია", "MFA provisioned")}
                            </div>
                          )}
                        </td>
                        <td>
                          <div className="flex flex-wrap gap-2">
                            {account.hold ? (
                              <>
                                {canRelease && (
                                  <Button
                                    variant="secondary"
                                    disabled={
                                      busy ||
                                      account.hold.own ||
                                      !account.active ||
                                      !account.hold.credentialChanged
                                    }
                                    onClick={(e) =>
                                      chooseHold(
                                        account,
                                        "release",
                                        e.currentTarget,
                                      )
                                    }
                                  >
                                    {t("შეზღუდვის მოხსნა", "Release hold")}
                                  </Button>
                                )}
                                {account.hold.own && (
                                  <p>
                                    {t(
                                      "საჭიროა სხვა ტექნიკური მენეჯერი.",
                                      "Another technical manager is required.",
                                    )}
                                  </p>
                                )}
                              </>
                            ) : (
                              canHold && (
                                <Button
                                  variant="danger"
                                  disabled={
                                    busy ||
                                    !account.active ||
                                    !account.recoverable
                                  }
                                  onClick={(e) =>
                                    chooseHold(account, "hold", e.currentTarget)
                                  }
                                >
                                  {t("ვებ-წვდომის შეჩერება", "Pause web access")}
                                </Button>
                              )
                            )}
                            {canPropose && account.active && (
                              <>
                                <Button
                                  variant="danger"
                                  disabled={
                                    busy || hasPending("disable_account")
                                  }
                                  onClick={(e) =>
                                    choosePropose(
                                      account,
                                      "disable_account",
                                      e.currentTarget,
                                    )
                                  }
                                >
                                  {t("ანგარიშის გამორთვა", "Disable account")}
                                </Button>
                                {account.lostContactEligible && (
                                  <Button
                                    variant="secondary"
                                    disabled={
                                      busy ||
                                      hasPending("lost_contact_recovery")
                                    }
                                    onClick={(e) =>
                                      choosePropose(
                                        account,
                                        "lost_contact_recovery",
                                        e.currentTarget,
                                      )
                                    }
                                  >
                                    {t(
                                      "დაკარგული კონტაქტის აღდგენა",
                                      "Lost-contact recovery",
                                    )}
                                  </Button>
                                )}
                                {(account.mfaEnabled ||
                                  account.mfaProvisioned) && (
                                  <Button
                                    variant="secondary"
                                    disabled={busy || hasPending("mfa_reset")}
                                    onClick={(e) =>
                                      choosePropose(
                                        account,
                                        "mfa_reset",
                                        e.currentTarget,
                                      )
                                    }
                                  >
                                    {t("MFA-ს გადაყენება", "Reset MFA")}
                                  </Button>
                                )}
                              </>
                            )}
                            {canPropose && !account.active && (
                              <Button
                                variant="secondary"
                                disabled={
                                  busy || hasPending("restore_account")
                                }
                                onClick={(e) =>
                                  choosePropose(
                                    account,
                                    "restore_account",
                                    e.currentTarget,
                                  )
                                }
                              >
                                {t("ანგარიშის აღდგენა", "Restore account")}
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex gap-3 mt-3">
            <Button
              variant="secondary"
              disabled={busy || !cursor}
              onClick={() => setCursors((v) => v.slice(0, -1))}
            >
              {t("წინა", "Previous accounts")}
            </Button>
            <Button
              variant="secondary"
              disabled={busy || !resource.data.nextBefore}
              onClick={() =>
                setCursors((v) => [...v, resource.data!.nextBefore!])
              }
            >
              {t("შემდეგი", "Next accounts")}
            </Button>
          </div>

          {proposals.length > 0 && (
            <div className="mt-6">
              <h3>
                {t(
                  "ანგარიშის სასიცოცხლო ცვლილებების განხილვა",
                  "Lifecycle & recovery proposals",
                )}
              </h3>
              <div className="overflow-x-auto mt-2">
                <table className="review-table">
                  <thead>
                    <tr>
                      <th>{t("ანგარიშის კოდი", "Account reference")}</th>
                      <th>{t("მოქმედება", "Proposal")}</th>
                      <th>{t("მდგომარეობა", "Status")}</th>
                      <th>{t("განხილვა", "Review")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {proposals.map((p) => (
                      <tr key={p.id}>
                        <td className="break-all">{p.accountId}</td>
                        <td>
                          <div>{actionLabel(p.action)}</div>
                          <div className="text-xs opacity-80">
                            {reasonLabel(p.reason)}
                            {p.newEmailHint ? ` · ${p.newEmailHint}` : ""}
                          </div>
                        </td>
                        <td>
                          <div>{statusLabel(p.status)}</div>
                          <div className="text-xs opacity-80">
                            {date(p.createdAt)}
                          </div>
                        </td>
                        <td>
                          {p.status === "pending" ? (
                            <div className="flex flex-wrap gap-2">
                              {canApprove && !p.mine && (
                                <>
                                  <Button
                                    variant="secondary"
                                    disabled={busy}
                                    onClick={(e) =>
                                      chooseReview(
                                        p,
                                        "approve",
                                        e.currentTarget,
                                      )
                                    }
                                  >
                                    {t("დამტკიცება", "Approve")}
                                  </Button>
                                  <Button
                                    variant="danger"
                                    disabled={busy}
                                    onClick={(e) =>
                                      chooseReview(p, "reject", e.currentTarget)
                                    }
                                  >
                                    {t("უარყოფა", "Reject")}
                                  </Button>
                                </>
                              )}
                              {canPropose && p.mine && (
                                <Button
                                  variant="secondary"
                                  disabled={busy}
                                  onClick={(e) =>
                                    chooseReview(p, "withdraw", e.currentTarget)
                                  }
                                >
                                  {t("გაწვევა", "Withdraw")}
                                </Button>
                              )}
                              {canApprove && p.mine && (
                                <p>
                                  {t(
                                    "საჭიროა სხვა ტექნიკური მენეჯერი.",
                                    "Another technical manager is required.",
                                  )}
                                </p>
                              )}
                            </div>
                          ) : (
                            <span className="text-xs opacity-80">
                              {p.reviewedAt ? date(p.reviewedAt) : "—"}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      <dialog
        ref={dialog}
        className="platform-dialog"
        aria-labelledby="account-security-title"
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
      >
        {selection && (
          <form onSubmit={submit} className="space-y-4">
            <h3 id="account-security-title">
              {selection.kind === "hold"
                ? t("ვებ-წვდომის შეჩერება", "Pause web access")
                : selection.kind === "release"
                  ? t("შეზღუდვის მოხსნა", "Release hold")
                  : selection.kind === "propose"
                    ? actionLabel(selection.action)
                    : selection.decision === "approve"
                      ? t("შეთავაზების დამტკიცება", "Approve proposal")
                      : selection.decision === "reject"
                        ? t("შეთავაზების უარყოფა", "Reject proposal")
                        : t("შეთავაზების გაწვევა", "Withdraw proposal")}
            </h3>
            <p className="break-all">
              {"account" in selection
                ? selection.account.id
                : selection.proposal.accountId}
            </p>
            <p>
              {selection.kind === "hold"
                ? t(
                    "ძველი სესიები და გამოუყენებელი აღდგენის/ელფოსტის შეცვლის ბმულები გაუქმდება. მფლობელს შეუძლია ახალი აღდგენა მოითხოვოს ადრე დადასტურებულ კონტაქტზე.",
                    "Old sessions and unused recovery/email-change links will be invalidated. The owner can request new recovery through the previously established contact.",
                  )
                : selection.kind === "release"
                  ? t(
                      "მოხსნა ძველ სესიებს არ აღადგენს და ორგანიზაციულ უფლებებს არ ცვლის. შესვლა კვლავ პაროლით ხდება.",
                      "Release does not revive old sessions or change organizational permissions. Normal password sign-in is still required.",
                    )
                  : selection.kind === "propose"
                    ? t(
                        "შეთავაზება ძალაში შევა მხოლოდ სხვა უფლებამოსილი ტექნიკური მენეჯერის დამტკიცების შემდეგ. ორგანიზაციული წევრობები და უფლებები უცვლელია.",
                        "This change takes effect only after independent approval by another technical manager. Organizational memberships and permissions remain unchanged.",
                      )
                    : t(
                        "დამტკიცების შემდეგ გაუქმდება ძველი სესიები და გამოუყენებელი ბმულები; რეგიონული წევრობა და უფლებები უცვლელი რჩება.",
                        "Approval closes active sessions and unused recovery proofs as required without altering regional memberships or permissions.",
                      )}
            </p>

            {selection.kind === "hold" && (
              <Select
                label={t("უსაფრთხოების მიზეზი", "Security reason")}
                value={reason}
                disabled={busy}
                onChange={(e) => {
                  setReason(e.target.value as HoldReason);
                  setIntent(false);
                }}
                options={[
                  {
                    value: "suspected_compromise",
                    label: t("კომპრომეტირების ეჭვი", "Suspected compromise"),
                  },
                  {
                    value: "credential_exposure",
                    label: t(
                      "შესვლის მონაცემების გაჟონვა",
                      "Credential exposure",
                    ),
                  },
                ]}
              />
            )}

            {selection.kind === "propose" && (
              <>
                <Select
                  label={t("სასიცოცხლო მიზეზი", "Lifecycle reason")}
                  value={lifecycleReason}
                  disabled={busy}
                  onChange={(e) => {
                    setLifecycleReason(e.target.value as LifecycleReason);
                    setIntent(false);
                  }}
                  options={
                    selection.action === "disable_account"
                      ? [
                          {
                            value: "policy_violation",
                            label: reasonLabel("policy_violation"),
                          },
                          {
                            value: "departure",
                            label: reasonLabel("departure"),
                          },
                        ]
                      : selection.action === "restore_account"
                        ? [
                            {
                              value: "account_restoration",
                              label: reasonLabel("account_restoration"),
                            },
                          ]
                        : selection.action === "lost_contact_recovery"
                          ? [
                              {
                                value: "lost_contact",
                                label: reasonLabel("lost_contact"),
                              },
                            ]
                          : [
                              {
                                value: "lost_mfa_device",
                                label: reasonLabel("lost_mfa_device"),
                              },
                              {
                                value: "mfa_compromise",
                                label: reasonLabel("mfa_compromise"),
                              },
                            ]
                  }
                />
                {selection.action === "lost_contact_recovery" && (
                  <Input
                    label={t(
                      "დადასტურებული ახალი ელფოსტა",
                      "Verified replacement email",
                    )}
                    type="email"
                    maxLength={254}
                    value={newEmail}
                    disabled={busy}
                    onChange={(e) => setNewEmail(e.target.value)}
                  />
                )}
              </>
            )}

            {selection.kind === "review" && selection.proposal.newEmailHint && (
              <p>
                {t("ახალი მისამართის მინიშნება:", "Replacement contact hint:")}{" "}
                <strong>{selection.proposal.newEmailHint}</strong>
              </p>
            )}

            {!allowed && (
              <p role="alert">
                {t(
                  "მონაცემები ან უფლებები შეიცვალა. დახურეთ და თავიდან აირჩიეთ ანგარიში.",
                  "The state or permissions changed. Close and select the account again.",
                )}
              </p>
            )}

            <label className="flex gap-3 items-center min-h-11">
              <input
                type="checkbox"
                checked={intent}
                disabled={busy}
                onChange={(e) => setIntent(e.target.checked)}
              />
              {t(
                "ვადასტურებ შერჩეული ანგარიშის უსაფრთხოების მოქმედებას.",
                "I confirm this security action for the selected account.",
              )}
            </label>

            <Input
              label={t("თქვენი მიმდინარე პაროლი", "Your current password")}
              type="password"
              autoComplete="current-password"
              value={password}
              disabled={busy}
              onChange={(e) => setPassword(e.target.value)}
            />

            <div className="flex flex-wrap gap-3">
              <Button
                type="submit"
                disabled={
                  busy ||
                  !allowed ||
                  !password ||
                  !intent ||
                  (needsNewEmail && (!normalizedNewEmail || !emailValid))
                }
              >
                {t("დადასტურება", "Confirm security action")}
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
      </dialog>
    </Card>
  );
}
