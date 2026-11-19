import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useNavigate } from "react-router-dom";
import { invitationsApi, type WebInvitation } from "../api/invitations";
import { collectiveApi, type CollectiveWrite } from "../api/collective";
import { apiErrorStatus } from "../api/errors";
import { useAsyncResource } from "../components/useAsyncResource";
import { useConsolePreferences } from "../components/useConsolePreferences";
import Card from "../components/ui/Card";
import Button from "../components/ui/Button";
import Select from "../components/ui/Select";
import Textarea from "../components/ui/Textarea";
import InviteContactForm from "../components/InviteContactForm";
import RevokeInviteContact from "../components/RevokeInviteContact";

export default function Invitations() {
  const { language } = useConsolePreferences(),
    navigate = useNavigate();
  const t = (ka: string, en: string) => (language === "ka" ? ka : en);
  const [revision, setRevision] = useState(0),
    [page, setPage] = useState(1),
    [contactPage, setContactPage] = useState(1);
  const contexts = useAsyncResource(String(revision), invitationsApi.contexts),
    org = contexts.data?.[0]?.id;
  const load = useCallback(
    async () =>
      org
        ? Promise.all([
            invitationsApi.contacts(org, contactPage),
            invitationsApi.list(org, page),
          ])
        : null,
    [org, contactPage, page],
  );
  const resource = useAsyncResource(
    JSON.stringify([org, revision, page, contactPage]),
    load,
  );
  const [selected, setSelected] = useState(""),
    [reason, setReason] = useState(""),
    [days, setDays] = useState("3");
  const [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [pending, setPending] = useState<CollectiveWrite | null>(null),
    [revoke, setRevoke] = useState<WebInvitation | null>(null);
  const lock = useRef(false);
  const revokeHeading = useRef<HTMLHeadingElement>(null);
  const contact = resource.data?.[0].items.find((c) => c.id === selected);
  const canCancel =
    !!org &&
    !contexts.loading &&
    !contexts.failed &&
    !resource.loading &&
    !resource.failed &&
    !!revoke &&
    resource.data?.[1].items.some(
      (i) => i.id === revoke.id && i.canRevoke && i.version === revoke.version,
    );
  const pendingInScope = !pending || pending.organizationId === org;
  useEffect(() => {
    if (canCancel) revokeHeading.current?.focus();
  }, [canCancel, revoke]);
  useEffect(() => {
    const refresh = () => setRevision((v) => v + 1);
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);
  const status = (value: string) =>
    ({
      pending: t("დასამტკიცებელი", "Awaiting approval"),
      approved: t("დამტკიცებული", "Approved"),
      delivery_pending: t("ელოდება მიწოდებას", "Awaiting delivery"),
      activation_pending: t("ელოდება აქტივაციას", "Awaiting activation"),
      activated: t("გააქტიურებული", "Activated"),
      revoked: t("გაუქმებული", "Revoked"),
      expired: t("ვადაგასული", "Expired"),
      unavailable: t("აღარ არის ხელმისაწვდომი", "Unavailable"),
      rejected: t("უარყოფილი", "Rejected"),
      withdrawn: t("გამოთხოვილი", "Withdrawn"),
    })[value] ?? value;
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (
      lock.current ||
      !org ||
      !pendingInScope ||
      !confirmed ||
      (!pending && (!contact || reason.trim().length < 3)) ||
      contexts.loading ||
      contexts.failed ||
      resource.failed ||
      resource.loading
    )
      return;
    const input = pending ?? {
      operation: "propose",
      organizationId: org,
      key: crypto.randomUUID(),
      unitId: contact!.unitId,
      kind: "account_invite",
      parameters: { contactId: contact!.id },
      reason: reason.trim(),
      deadline: new Date(Date.now() + Number(days) * 86400000).toISOString(),
    };
    lock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    setPending(input);
    try {
      await collectiveApi.write(input);
      setPending(null);
      setSelected("");
      setReason("");
      setConfirmed(false);
      setRevision((v) => v + 1);
      setNotice(
        t(
          "მოწვევა წარდგენილია დამოუკიდებელი დამტკიცებისთვის.",
          "Invitation submitted for independent approval.",
        ),
      );
      window.dispatchEvent(new Event("ertad-reviews-changed"));
    } catch (e) {
      const code = apiErrorStatus(e);
      if (code && code < 500) {
        setPending(null);
        setConfirmed(false);
      }
      setError(
        !code || code >= 500
          ? t(
              "შედეგი გაურკვეველია. განმეორება გამოიყენებს იმავე მოთხოვნას.",
              "Outcome uncertain. Retrying uses the same request.",
            )
          : t(
              "მოთხოვნა ვერ შესრულდა. განაახლეთ მონაცემები და გადაამოწმეთ უფლებები.",
              "Request failed. Refresh and check current permissions.",
            ),
      );
    } finally {
      setBusy(false);
      lock.current = false;
    }
  }
  async function cancel() {
    if (lock.current || !org || !revoke || !canCancel || !confirmed) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await invitationsApi.revoke(org, revoke.id);
      setRevoke(null);
      setNotice(t("მოწვევა გაუქმებულია.", "Invitation revoked."));
    } catch {
      setError(
        t(
          "გაუქმების შედეგი ვერ დადასტურდა. გადაამოწმეთ განახლებული სტატუსი.",
          "Revocation could not be confirmed. Check the refreshed status.",
        ),
      );
    } finally {
      setConfirmed(false);
      setRevision((v) => v + 1);
      setBusy(false);
      lock.current = false;
    }
  }
  return (
    <div className="review-page">
      <h1 className="text-2xl font-bold">
        {t("ვებმოწვევები", "Web invitations")}
      </h1>
      <p>
        {t(
          "მოიწვიეთ არსებული წევრი ვებანგარიშის გასააქტიურებლად. პოზიცია და უფლებები ცალკე იმართება.",
          "Invite an existing member to activate a web account. Positions and permissions are managed separately.",
        )}
      </p>
      <Button
        variant="secondary"
        disabled={busy}
        onClick={() => setRevision((v) => v + 1)}
      >
        {t("განახლება", "Refresh")}
      </Button>
      {(contexts.loading || resource.loading) && (
        <p role="status">{t("იტვირთება…", "Loading…")}</p>
      )}
      {(contexts.failed || resource.failed) && (
        <p role="alert">
          {t("მონაცემები ვერ ჩაიტვირთა.", "Could not load invitations.")}
        </p>
      )}
      {contexts.data?.length === 0 && (
        <p>
          {t(
            "მოწვევების მართვის უფლება არ გაქვთ.",
            "You do not have invitation-management access.",
          )}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {org && resource.data && (
        <>
          <InviteContactForm
            organizationId={org}
            onCreated={() => {
              setNotice(
                t(
                  "კონტაქტი შენახულია. ახლა შექმენით მოწვევა და წარადგინეთ დამოუკიდებლად დასამტკიცებლად.",
                  "Contact saved. Create an invitation and submit it for independent approval.",
                ),
              );
              setRevision((v) => v + 1);
            }}
          />
          <Card>
            <form onSubmit={(e) => void submit(e)} className="space-y-4">
              <h2 className="text-lg font-semibold">
                {t("მოწვევის შექმნა", "Create invitation")}
              </h2>
              <p>
                {t(
                  "რეალურ ადრესატს დამტკიცების შემდეგ ჯერ ელფოსტის დადასტურების ბმული გაეგზავნება, შემდეგ — აქტივაციის. მიწოდების სერვისი ტექნიკურმა მენეჯერმა უნდა ჩართოს. სატესტო კონტაქტები ადგილობრივ არხს ინარჩუნებს.",
                  "After approval, a real recipient confirms their email before receiving activation. Technical management must enable delivery. Synthetic contacts keep the local channel.",
                )}
              </p>
              <fieldset
                disabled={busy || !!pending || !!revoke}
                className="space-y-4"
              >
                <Select
                  label={t("ადრესატი", "Recipient")}
                  value={selected}
                  onChange={(e) => {
                    setSelected(e.target.value);
                    setConfirmed(false);
                  }}
                  options={[
                    { value: "", label: t("აირჩიეთ წევრი", "Select a member") },
                    ...resource.data[0].items.map((c) => ({
                      value: c.id,
                      label: `${c.displayName ?? c.memberId} · ${c.unitName} · ${c.contactHint}`,
                    })),
                  ]}
                />
                {!resource.data[0].items.length && (
                  <p>
                    {t(
                      "ამ გვერდზე მოსაწვევი წევრი არ მოიძებნა.",
                      "No eligible recipients on this page.",
                    )}
                  </p>
                )}
                <div className="flex flex-wrap gap-3">
                  <Button
                    variant="secondary"
                    disabled={contactPage === 1}
                    onClick={() => {
                      setContactPage((p) => p - 1);
                      setSelected("");
                      setConfirmed(false);
                    }}
                  >
                    {t("წინა ადრესატები", "Previous recipients")}
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={resource.data[0].items.length < 25}
                    onClick={() => {
                      setContactPage((p) => p + 1);
                      setSelected("");
                      setConfirmed(false);
                    }}
                  >
                    {t("შემდეგი ადრესატები", "Next recipients")}
                  </Button>
                </div>
                <Select
                  label={t("მოთხოვნის ვადა", "Request lifetime")}
                  value={days}
                  onChange={(e) => {
                    setDays(e.target.value);
                    setConfirmed(false);
                  }}
                  options={[1, 3, 7].map((d) => ({
                    value: String(d),
                    label: `${d} ${t("დღე", "days")}`,
                  }))}
                />
                <Textarea
                  label={t("მიზეზი", "Reason")}
                  value={reason}
                  maxLength={1000}
                  onChange={(e) => {
                    setReason(e.target.value);
                    setConfirmed(false);
                  }}
                />
              </fieldset>
              {!revoke && (
                <label className="flex items-center gap-3 min-h-11">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    disabled={busy}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />
                  {t(
                    "ვადასტურებ მოწვევის წარდგენას",
                    "I confirm submitting this invitation",
                  )}
                </label>
              )}
              <Button
                type="submit"
                disabled={
                  busy ||
                  !!revoke ||
                  !pendingInScope ||
                  !confirmed ||
                  (!pending && (!contact || reason.trim().length < 3))
                }
              >
                {pending
                  ? t("იგივე მოთხოვნის განმეორება", "Retry same request")
                  : t("დასამტკიცებლად გაგზავნა", "Submit for approval")}
              </Button>
            </form>
          </Card>
          {contact?.source === "email" && (
            <RevokeInviteContact
              key={org + ":" + contact.id}
              organizationId={org}
              contact={contact}
              disabled={busy || !!pending || !!revoke}
              onSettled={(success) => {
                setSelected("");
                setConfirmed(false);
                setRevision((v) => v + 1);
                if (success) {
                  setError("");
                  setNotice(
                    t(
                      "კონტაქტი გაუქმებულია. სწორი მისამართისთვის შექმენით ახალი კონტაქტი და მოწვევა.",
                      "Contact revoked. Create a new contact and invitation for the corrected address.",
                    ),
                  );
                } else {
                  setNotice("");
                  setError(
                    t(
                      "გაუქმების შედეგი ვერ დადასტურდა. გადაამოწმეთ განახლებული სია; მოთხოვნა ავტომატურად არ განმეორდება.",
                      "Revocation is unconfirmed. Check the refreshed list; the request will not retry automatically.",
                    ),
                  );
                }
              }}
            />
          )}
          <Card>
            <h2 className="text-lg font-semibold">
              {t("მოწვევების მდგომარეობა", "Invitation status")}
            </h2>
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr>
                    <th className="p-2">
                      {t("წევრი / ერთეული", "Member / unit")}
                    </th>
                    <th className="p-2">{t("სტატუსი", "Status")}</th>
                    <th className="p-2">{t("ვადა", "Deadline")}</th>
                    <th className="p-2">{t("მოქმედება", "Action")}</th>
                  </tr>
                </thead>
                <tbody>
                  {resource.data[1].items.map((i) => (
                    <tr key={i.id}>
                      <td className="p-2">
                        {i.displayName ?? t("წევრი", "Member")}
                        <p>{i.unitName}</p>
                      </td>
                      <td className="p-2">
                        {status(i.status)}
                        {i.needsEmailProof && (
                          <p>
                            {t(
                              "საჭიროა ელფოსტის დადასტურება",
                              "Email proof required",
                            )}
                          </p>
                        )}
                        {i.mailStatus && (
                          <p>
                            {(
                              {
                                queued: t("წერილი რიგშია", "Email queued"),
                                sending: t(
                                  "მიმდინარეობს გაგზავნა",
                                  "Sending email",
                                ),
                                retry: t(
                                  "დაგეგმილია განმეორებითი მცდელობა",
                                  "Retry scheduled",
                                ),
                                accepted: t(
                                  "პროვაიდერმა მიიღო — მიწოდება არ დასტურდება",
                                  "Provider accepted — delivery unconfirmed",
                                ),
                                failed: t(
                                  "გაგზავნა უარყოფილია",
                                  "Email rejected",
                                ),
                                uncertain: t(
                                  "გაგზავნის შედეგი გაურკვეველია",
                                  "Email outcome uncertain",
                                ),
                                cancelled: t(
                                  "გაგზავნა გაუქმებულია",
                                  "Email cancelled",
                                ),
                              } as Record<string, string>
                            )[i.mailStatus] ??
                              t(
                                "მიწოდების სტატუსი უცნობია",
                                "Delivery status unknown",
                              )}
                          </p>
                        )}
                      </td>
                      <td className="p-2">
                        {new Date(i.deadline).toLocaleString(
                          language === "ka" ? "ka-GE" : "en-GB",
                          { hour12: false },
                        )}
                      </td>
                      <td className="p-2">
                        <div className="flex flex-wrap gap-3">
                          <Button
                            variant="secondary"
                            onClick={() =>
                              navigate("/approvals", {
                                state: {
                                  inbox: {
                                    source: "collective",
                                    organizationId: org,
                                    id: i.id,
                                  },
                                },
                              })
                            }
                          >
                            {t("დამტკიცების ნახვა", "Review request")}
                          </Button>
                          {i.canRevoke && (
                            <Button
                              variant="secondary"
                              disabled={busy || !!pending}
                              onClick={() => {
                                setRevoke(i);
                                setConfirmed(false);
                                setNotice("");
                              }}
                            >
                              {t("მოწვევის გაუქმება", "Revoke invitation")}
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!resource.data[1].items.length && (
              <p>{t("მოწვევები ჯერ არ არის.", "No invitations yet.")}</p>
            )}
            <div className="flex flex-wrap gap-3 mt-3">
              <Button
                variant="secondary"
                disabled={page === 1 || busy}
                onClick={() => setPage((p) => p - 1)}
              >
                {t("წინა", "Previous")}
              </Button>
              <Button
                variant="secondary"
                disabled={resource.data[1].items.length < 25 || busy}
                onClick={() => setPage((p) => p + 1)}
              >
                {t("შემდეგი", "Next")}
              </Button>
            </div>
          </Card>
        </>
      )}
      {revoke && canCancel && (
        <Card>
          <h2 ref={revokeHeading} tabIndex={-1} className="font-semibold">
            {t("მოწვევის გაუქმება", "Revoke invitation")} — {revoke.displayName}
          </h2>
          <p>
            {t(
              "აქტივაციის ბმული ვეღარ გამოიყენება. ეს უკვე შექმნილ ანგარიშს არ თიშავს.",
              "The activation link will no longer work. This does not disable an already created account.",
            )}
          </p>
          <label className="flex gap-3 items-center min-h-11">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              disabled={busy}
            />
            {t("ვადასტურებ გაუქმებას", "I confirm revocation")}
          </label>
          <div className="flex gap-3">
            <Button disabled={busy || !confirmed} onClick={() => void cancel()}>
              {t("დადასტურება", "Confirm")}
            </Button>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setRevoke(null);
                setConfirmed(false);
              }}
            >
              {t("უკან", "Back")}
            </Button>
          </div>
        </Card>
      )}
      {revoke && !canCancel && !resource.loading && (
        <Button
          variant="secondary"
          onClick={() => {
            setRevoke(null);
            setConfirmed(false);
          }}
        >
          {t("მოწვევების სიაში დაბრუნება", "Return to invitation list")}
        </Button>
      )}
    </div>
  );
}
