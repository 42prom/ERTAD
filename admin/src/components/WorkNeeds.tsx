import { useState, type FormEvent } from "react";
import Card from "./ui/Card";
import Button from "./ui/Button";
import Input from "./ui/Input";
import Textarea from "./ui/Textarea";
import Select from "./ui/Select";
import { useConsolePreferences } from "./useConsolePreferences";
import type { WorkDetail, WorkNeedsAction, WorkWrite } from "../api/work";

export default function WorkNeeds({
  detail: d,
  organizationId,
  locked,
  person,
  onWrite,
}: {
  detail: WorkDetail;
  organizationId: string;
  locked: boolean;
  person: (id: string) => string;
  onWrite: (input: WorkWrite) => Promise<void>;
}) {
  const { language } = useConsolePreferences();
  const t = (ka: string, en: string) => (language === "ka" ? ka : en);
  const [mode, setMode] = useState<WorkNeedsAction | null>(null),
    [target, setTarget] = useState("");
  const [title, setTitle] = useState(""),
    [note, setNote] = useState(""),
    [quantity, setQuantity] = useState("1");
  const [kind, setKind] = useState("resource"),
    [gate, setGate] = useState("optional"),
    [unit, setUnit] = useState("");
  const [owner, setOwner] = useState(d.actorId),
    [qualification, setQualification] = useState(
      d.qualificationCatalog?.[0]?.id ?? "",
    );
  const [requirements, setRequirements] = useState<string[]>([]),
    [reference, setReference] = useState("");
  const localDate = (value: string) => {
    const v = new Date(value);
    return new Date(v.getTime() - v.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
  };
  const [date, setDate] = useState(localDate(d.deadline));
  const open = d.status === "open",
    catalog = d.qualificationCatalog ?? [];
  const label = (key: string) =>
    (
      ({
        need_create: t("საჭიროების დამატება", "Add need"),
        need_cancel: t("საჭიროების გაუქმება", "Cancel need"),
        provision_offer: t("დახმარების შეთავაზება", "Offer provision"),
        provision_confirm: t("მიღების დადასტურება", "Confirm receipt"),
        provision_withdraw: t("შეთავაზების გამოთხოვა", "Withdraw offer"),
        provision_return: t("დაბრუნების აღრიცხვა", "Record return"),
        provision_reject: t("შეთავაზების უარყოფა", "Reject offer"),
        qualification_define: t(
          "კვალიფიკაციის განსაზღვრა",
          "Define qualification",
        ),
        qualification_claim: t(
          "ჩემი კვალიფიკაციის წარდგენა",
          "Submit my qualification",
        ),
        qualification_verify: t(
          "კვალიფიკაციის დადასტურება",
          "Verify qualification",
        ),
        qualification_reject: t(
          "კვალიფიკაციის უარყოფა",
          "Reject qualification",
        ),
        qualification_revoke: t(
          "კვალიფიკაციის გაუქმება",
          "Revoke qualification",
        ),
        people: t("ადამიანები", "People"),
        resource: t("რესურსი", "Resource"),
        service: t("მომსახურება", "Service"),
        optional: t("არჩევითი", "Optional"),
        start: t("აუცილებელია დაწყებისთვის", "Required to start"),
        complete: t("აუცილებელია დასრულებისთვის", "Required to complete"),
        pending: t("დასადასტურებელი", "Pending"),
        verified: t("დადასტურებული", "Verified"),
        rejected: t("უარყოფილი", "Rejected"),
        revoked: t("გაუქმებული", "Revoked"),
        pledged: t("დაპირებული", "Pledged"),
        confirmed: t("მიღებული", "Confirmed"),
        withdrawn: t("გამოთხოვილი", "Withdrawn"),
        returned: t("დაბრუნებული", "Returned"),
      }) as Record<string, string>
    )[key] ?? key;
  const choose = (op: WorkNeedsAction, id = "") => {
    setMode(op);
    setTarget(id);
    setNote("");
  };
  const action = (op: WorkNeedsAction, id = "") => (
    <Button
      disabled={locked}
      variant="secondary"
      onClick={() => choose(op, id)}
    >
      {label(op)}
    </Button>
  );
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!mode) return;
    const extra =
      mode === "need_create"
        ? {
            kind,
            title,
            quantity,
            unitLabel: unit,
            gate,
            memberId: owner,
            deadline: new Date(date).toISOString(),
            qualificationIds: kind === "people" ? requirements : [],
          }
        : mode === "need_cancel"
          ? { needId: target }
          : mode === "provision_offer"
            ? { needId: target, quantity }
            : mode.startsWith("provision_")
              ? { provisionId: target }
              : mode === "qualification_define"
                ? { title }
                : mode === "qualification_claim"
                  ? { qualificationId: qualification, reference }
                  : mode === "qualification_verify"
                    ? {
                        claimId: target,
                        validUntil: new Date(date).toISOString(),
                      }
                    : { claimId: target };
    await onWrite({
      organizationId,
      key: crypto.randomUUID(),
      id: d.id,
      version: d.version,
      operation: mode,
      note,
      ...extra,
    });
  }
  return (
    <>
      <Card>
        <h2 className="text-xl font-semibold mb-3">
          {t("საჭიროებები და უზრუნველყოფა", "Needs and provision")}
        </h2>
        <p className="mb-3">
          {t(
            "დაპირება და მიღებული დახმარება ცალ-ცალკე აღირიცხება. მიღებას სხვა უფლებამოსილი პირი ადასტურებს.",
            "Pledges and received help are recorded separately. Another authorized person confirms receipt.",
          )}
        </p>
        {open &&
          d.canManage &&
          d.assignments.length === 0 &&
          d.children.every((c) => c.status === "cancelled") &&
          action("need_create")}
        {!d.needs?.length && (
          <p className="mt-3">
            {t("საჭიროებები ჯერ არ დამატებულა.", "No needs have been defined.")}
          </p>
        )}
        <div className="space-y-4 mt-4">
          {d.needs?.map((n) => (
            <section key={n.id} className="rounded-lg border p-4 space-y-3">
              <h3 className="font-semibold">
                {n.title} · {label(n.kind)}
                {n.cancelled && ` · ${t("გაუქმებულია", "Cancelled")}`}
              </h3>
              <p>
                {t("საჭიროა", "Required")}: {n.quantity} {n.unitLabel} ·{" "}
                {t("დადასტურებულია", "Confirmed")}: {n.confirmed} ·{" "}
                {t("დარჩა", "Remaining")}: {n.remaining} ·{" "}
                {t("დაპირებულია", "Pledged")}: {n.pledged}
              </p>
              <p>
                {label(n.gate)} · {person(n.ownerId)} ·{" "}
                {new Date(n.deadline).toLocaleString(
                  language === "ka" ? "ka-GE" : "en-GB",
                  { hour12: false },
                )}
              </p>
              {!!n.qualificationIds.length && (
                <p>
                  {t("კვალიფიკაციები", "Qualifications")}:{" "}
                  {n.qualificationIds
                    .map((id) => catalog.find((q) => q.id === id)?.title ?? id)
                    .join(", ")}{" "}
                  ·{" "}
                  {n.qualified
                    ? t(
                        "თქვენ აკმაყოფილებთ მოთხოვნებს",
                        "You meet the requirements",
                      )
                    : t(
                        "დადასტურება ჯერ გჭირდებათ",
                        "Verification is required",
                      )}
                </p>
              )}
              {!n.cancelled && (
                <div className="flex flex-wrap gap-2">
                  {open &&
                    d.canParticipate &&
                    n.kind !== "people" &&
                    action("provision_offer", n.id)}
                  {open &&
                    d.canManage &&
                    d.assignments.length === 0 &&
                    action("need_cancel", n.id)}
                </div>
              )}
              {n.provisions.map((p) => (
                <div key={p.id} className="border-t pt-3 space-y-2">
                  <p>
                    {person(p.memberId)} · {p.quantity} {n.unitLabel} ·{" "}
                    {label(p.status)}
                  </p>
                  <p>{p.note}</p>
                  <div className="flex flex-wrap gap-2">
                    {open &&
                      p.status === "pledged" &&
                      p.memberId === d.actorId &&
                      action("provision_withdraw", p.id)}
                    {open &&
                      p.status === "pledged" &&
                      d.canVerify &&
                      p.memberId !== d.actorId &&
                      action("provision_confirm", p.id)}
                    {open &&
                      p.status === "pledged" &&
                      d.canManage &&
                      action("provision_reject", p.id)}
                    {p.status === "confirmed" &&
                      d.canManage &&
                      action("provision_return", p.id)}
                  </div>
                </div>
              ))}
            </section>
          ))}
        </div>
      </Card>
      <Card>
        <h2 className="text-xl font-semibold mb-3">
          {t("კვალიფიკაციები", "Qualifications")}
        </h2>
        <p className="mb-3">
          {t(
            "დანიშვნისა და შესრულებისას მოწმდება კვალიფიკაციის ვადა და გაუქმება. აქ მიუთითეთ მხოლოდ შემოწმების არასენსიტიური ცნობარი; პირადი დოკუმენტები არ ატვირთოთ.",
            "Assignment and completion check qualification expiry and revocation. Use only a non-sensitive verification reference; do not enter personal documents.",
          )}
        </p>
        <div className="flex flex-wrap gap-2">
          {open && d.canManage && action("qualification_define")}
          {open &&
            d.canParticipate &&
            catalog.length > 0 &&
            action("qualification_claim")}
        </div>
        {!d.qualificationClaims?.length && (
          <p className="mt-3">
            {t(
              "თქვენთვის ხილული განაცხადები არ არის.",
              "No visible qualification claims.",
            )}
          </p>
        )}
        {d.qualificationClaims?.map((c) => (
          <section key={c.id} className="border-t mt-4 pt-4 space-y-2">
            <h3 className="font-semibold">
              {catalog.find((q) => q.id === c.qualificationId)?.title} ·{" "}
              {person(c.memberId)} · {label(c.status)}
            </h3>
            <p>{c.reference}</p>
            <p>{c.reviewNote}</p>
            {c.validUntil && (
              <p>
                {t("მოქმედებს", "Valid until")}:{" "}
                {new Date(c.validUntil).toLocaleString(
                  language === "ka" ? "ka-GE" : "en-GB",
                  { hour12: false },
                )}
              </p>
            )}
            {d.canVerifyQualifications && c.memberId !== d.actorId && (
              <div className="flex flex-wrap gap-2">
                {open && c.status === "pending" && (
                  <>
                    {action("qualification_verify", c.id)}
                    {action("qualification_reject", c.id)}
                  </>
                )}
                {c.status === "verified" &&
                  action("qualification_revoke", c.id)}
              </div>
            )}
          </section>
        ))}
      </Card>
      {mode && (
        <Card>
          <h2 className="text-xl font-semibold mb-3">{label(mode)}</h2>
          <form onSubmit={save}>
            <fieldset disabled={locked} className="space-y-4">
              {["need_create", "qualification_define"].includes(mode) && (
                <Input
                  label={t("სახელი", "Name")}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  required
                  minLength={3}
                  maxLength={mode === "qualification_define" ? 100 : 160}
                />
              )}
              {mode === "need_create" && (
                <>
                  <Select
                    label={t("საჭიროების ტიპი", "Need type")}
                    value={kind}
                    onChange={(e) => setKind(e.target.value)}
                    options={["people", "resource", "service"].map((value) => ({
                      value,
                      label: label(value),
                    }))}
                  />
                  <Input
                    label={t("საზომი ერთეული", "Measurement unit")}
                    value={unit}
                    onChange={(e) => setUnit(e.target.value)}
                    required
                    maxLength={40}
                  />
                  <Select
                    label={t("აუცილებლობა", "Requirement gate")}
                    value={gate}
                    onChange={(e) => setGate(e.target.value)}
                    options={["optional", "start", "complete"].map((value) => ({
                      value,
                      label: label(value),
                    }))}
                  />
                  <Select
                    label={t("პასუხისმგებელი", "Need owner")}
                    value={owner}
                    onChange={(e) => setOwner(e.target.value)}
                    options={(d.coordinators ?? [d.actorId]).map((value) => ({
                      value,
                      label: person(value),
                    }))}
                  />
                  {kind === "people" && (
                    <fieldset>
                      <legend>
                        {t(
                          "აუცილებელი კვალიფიკაციები",
                          "Required qualifications",
                        )}
                      </legend>
                      {catalog.map((q) => (
                        <label
                          key={q.id}
                          className="flex items-center gap-2 min-h-11"
                        >
                          <input
                            type="checkbox"
                            checked={requirements.includes(q.id)}
                            onChange={(e) =>
                              setRequirements(
                                e.target.checked
                                  ? [...requirements, q.id]
                                  : requirements.filter((id) => id !== q.id),
                              )
                            }
                          />
                          {q.title}
                        </label>
                      ))}
                    </fieldset>
                  )}
                </>
              )}
              {["need_create", "provision_offer"].includes(mode) && (
                <Input
                  label={t("რაოდენობა", "Quantity")}
                  type="number"
                  min="0.001"
                  max="1000000"
                  step={
                    mode === "need_create" && kind === "people" ? "1" : "0.001"
                  }
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  required
                />
              )}
              {["need_create", "qualification_verify"].includes(mode) && (
                <Input
                  label={
                    mode === "need_create"
                      ? t("საჭიროების ვადა", "Need deadline")
                      : t(
                          "კვალიფიკაციის მოქმედების ვადა",
                          "Qualification expiry",
                        )
                  }
                  type="datetime-local"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  required
                />
              )}
              {mode === "qualification_claim" && (
                <>
                  <Select
                    label={t("კვალიფიკაცია", "Qualification")}
                    value={qualification}
                    onChange={(e) => setQualification(e.target.value)}
                    required
                    options={catalog.map((q) => ({
                      value: q.id,
                      label: q.title,
                    }))}
                  />
                  <Input
                    label={t("შემოწმების ცნობარი", "Verification reference")}
                    value={reference}
                    onChange={(e) => setReference(e.target.value)}
                    minLength={3}
                    maxLength={500}
                    required
                  />
                </>
              )}
              <Textarea
                label={t("შენიშვნა / მიზეზი", "Need or qualification note")}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={1000}
                minLength={3}
                required={
                  ![
                    "need_create",
                    "qualification_define",
                    "qualification_claim",
                    "provision_offer",
                    "provision_withdraw",
                  ].includes(mode)
                }
              />
              <div className="flex gap-2">
                <Button type="submit">
                  {t("ცვლილების შენახვა", "Save need change")}
                </Button>
                <Button variant="secondary" onClick={() => setMode(null)}>
                  {t("დახურვა", "Close")}
                </Button>
              </div>
            </fieldset>
          </form>
        </Card>
      )}
    </>
  );
}
