import { useEffect, useRef, useState, type FormEvent } from "react";
import type { WorkAmendment, WorkDetail, WorkWrite } from "../api/work";
import { useConsolePreferences } from "./useConsolePreferences";
import Button from "./ui/Button";
import Input from "./ui/Input";
import Textarea from "./ui/Textarea";
import Select from "./ui/Select";
import Card from "./ui/Card";

function localTime(value: string | null | undefined) {
  if (!value) return "";
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
}

export default function TaskDefinitionEditor({
  detail,
  organizationId,
  locked,
  onWrite,
  onCancel,
}: {
  detail: WorkDetail;
  organizationId: string;
  locked: boolean;
  onWrite: (request: WorkWrite) => Promise<void>;
  onCancel: () => void;
}) {
  const { language } = useConsolePreferences();
  const t = (ka: string, en: string) => (language === "ka" ? ka : en);
  const heading = useRef<HTMLHeadingElement>(null);
  const [draft, setDraft] = useState({
    title: detail.title,
    description: detail.description,
    priority: detail.priority,
    capacity: detail.capacity,
    deadline: localTime(detail.deadline),
    startsAt: localTime(detail.startsAt),
    location: detail.location ?? "",
    note: "",
  });
  useEffect(() => {
    heading.current?.focus();
    const guard = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, []);
  const minCapacity = Math.max(
    1,
    detail.used,
    (detail.needs ?? [])
      .filter((n) => n.kind === "people" && !n.cancelled)
      .reduce((sum, n) => sum + Number(n.quantity), 0),
  );
  const changed =
    draft.title !== detail.title ||
    draft.description !== detail.description ||
    draft.priority !== detail.priority ||
    draft.capacity !== detail.capacity ||
    draft.deadline !== localTime(detail.deadline) ||
    draft.startsAt !== localTime(detail.startsAt) ||
    draft.location !== (detail.location ?? "");
  function save(event: FormEvent) {
    event.preventDefault();
    if (locked || !changed || draft.note.trim().length < 3) return;
    void onWrite({
      operation: "edit",
      organizationId,
      id: detail.id,
      version: detail.version,
      key: crypto.randomUUID(),
      ...draft,
      title: draft.title.trim(),
      note: draft.note.trim(),
      location: draft.location.trim(),
      // Preserve the original instant (including seconds and offset) unless the user changes it.
      deadline:
        draft.deadline === localTime(detail.deadline)
          ? detail.deadline
          : new Date(draft.deadline).toISOString(),
      startsAt:
        draft.startsAt === localTime(detail.startsAt)
          ? (detail.startsAt ?? null)
          : draft.startsAt
            ? new Date(draft.startsAt).toISOString()
            : null,
    });
  }
  if (!detail.canManage || detail.status !== "open") return null;
  return (
    <Card>
      <h2 ref={heading} tabIndex={-1} className="text-xl font-bold">
        {t("დავალების რედაქტირება", "Edit task")}
      </h2>
      <p id="task-edit-help" className="mt-2 text-sm text-[var(--muted)]">
        {t(
          "ცვლილება და მისი მიზეზი დარჩება ისტორიაში; მონაწილეები მიიღებენ შეტყობინებას. შესრულება და ჯილდოს პირობები შენარჩუნდება. ვადა უნდა ითვალისწინებდეს ქვედა დავალებებსა და საჭიროებებს.",
          "Changes and the reason stay in history; participants are notified. Completion records and reward terms are preserved. The deadline must accommodate delegated tasks and needs.",
        )}
      </p>
      <form
        className="mt-4 space-y-4"
        onSubmit={save}
        aria-describedby="task-edit-help"
      >
        <fieldset disabled={locked} className="space-y-4 min-w-0">
          <label className="block">
            {t("სათაური", "Title")}
            <Input
              required
              minLength={3}
              maxLength={160}
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          </label>
          <Textarea
            label={t("აღწერა", "Description")}
            maxLength={3000}
            value={draft.description}
            onChange={(e) =>
              setDraft({ ...draft, description: e.target.value })
            }
          />
          <div className="grid gap-4 md:grid-cols-2">
            <label>
              {t("ვადა", "Deadline")}
              <Input
                required
                type="datetime-local"
                value={draft.deadline}
                onChange={(e) =>
                  setDraft({ ...draft, deadline: e.target.value })
                }
              />
            </label>
            <label>
              {t("დაწყება", "Starts")}
              <Input
                type="datetime-local"
                max={draft.deadline}
                value={draft.startsAt}
                onChange={(e) =>
                  setDraft({ ...draft, startsAt: e.target.value })
                }
              />
            </label>
            <label>
              {t("შეხვედრის ადგილი", "Meeting place")}
              <Input
                maxLength={300}
                value={draft.location}
                onChange={(e) =>
                  setDraft({ ...draft, location: e.target.value })
                }
              />
            </label>
            <Select
              label={t("პრიორიტეტი", "Priority")}
              value={draft.priority}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  priority: e.target.value as WorkDetail["priority"],
                })
              }
              options={[
                { value: "low", label: t("დაბალი", "Low") },
                { value: "normal", label: t("ჩვეულებრივი", "Normal") },
                { value: "high", label: t("მაღალი", "High") },
                { value: "urgent", label: t("სასწრაფო", "Urgent") },
              ]}
            />
            <label>
              {t("ადგილების რაოდენობა", "Capacity")}
              <Input
                required
                type="number"
                min={minCapacity}
                max={100}
                disabled={!!detail.parentId}
                value={draft.capacity}
                onChange={(e) =>
                  setDraft({ ...draft, capacity: Number(e.target.value) })
                }
                aria-describedby="task-capacity-help"
              />
            </label>
          </div>
          <p id="task-capacity-help" className="text-sm text-[var(--muted)]">
            {detail.parentId
              ? t(
                  "ადგილების რაოდენობა განსაზღვრულია ზედა დონის მიერ და აქ არ იცვლება.",
                  "Capacity is allocated by the parent task and cannot be changed here.",
                )
              : t(
                  `მინიმუმ ${minCapacity} ადგილი: უკვე განაწილებული ადგილები და როლების ლიმიტები შენარჩუნდება.`,
                  `Minimum ${minCapacity} places: existing allocations and role limits are preserved.`,
                )}
          </p>
          <Textarea
            label={t("ცვლილების მიზეზი", "Reason for change")}
            required
            minLength={3}
            maxLength={1000}
            value={draft.note}
            onChange={(e) => setDraft({ ...draft, note: e.target.value })}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              disabled={!changed || draft.note.trim().length < 3}
            >
              {t("ცვლილებების შენახვა", "Save changes")}
            </Button>
            <Button type="button" variant="secondary" onClick={onCancel}>
              {t("გაუქმება", "Cancel")}
            </Button>
          </div>
        </fieldset>
      </form>
    </Card>
  );
}

export function TaskDefinitionChanges({
  before,
  after,
}: {
  before: WorkAmendment;
  after: WorkAmendment;
}) {
  const { language } = useConsolePreferences();
  const t = (ka: string, en: string) => (language === "ka" ? ka : en);
  const labels: Record<keyof WorkAmendment, string> = {
    title: t("სათაური", "Title"),
    description: t("აღწერა", "Description"),
    priority: t("პრიორიტეტი", "Priority"),
    capacity: t("ადგილები", "Capacity"),
    deadline: t("ვადა", "Deadline"),
    startsAt: t("დაწყება", "Starts"),
    location: t("ადგილი", "Place"),
  };
  function format(key: keyof WorkAmendment, value: string | number | null) {
    if (value === null || value === "")
      return t("არ არის მითითებული", "Not specified");
    if (key === "deadline" || key === "startsAt")
      return new Date(value).toLocaleString(
        language === "ka" ? "ka-GE" : "en-GB",
        { hour12: false },
      );
    if (key === "priority")
      return (
        {
          low: t("დაბალი", "Low"),
          normal: t("ჩვეულებრივი", "Normal"),
          high: t("მაღალი", "High"),
          urgent: t("სასწრაფო", "Urgent"),
        }[String(value)] ?? value
      );
    return value;
  }
  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-[var(--primary)]">
        {t("ცვლილებების ნახვა", "View changes")}
      </summary>
      <dl className="mt-2 space-y-2">
        {(Object.keys(labels) as (keyof WorkAmendment)[])
          .filter((key) => before[key] !== after[key])
          .map((key) => (
            <div key={key} className="break-words whitespace-pre-wrap">
              <dt className="font-medium">{labels[key]}</dt>
              <dd>
                {t("იყო", "Before")}: {format(key, before[key])}
              </dd>
              <dd>
                {t("ახლა", "After")}: {format(key, after[key])}
              </dd>
            </div>
          ))}
      </dl>
    </details>
  );
}
