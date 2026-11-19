import { useEffect, useState } from "react";
import type { WorkDetail, WorkWrite } from "../api/work";
import { useConsolePreferences } from "./useConsolePreferences";
import Button from "./ui/Button";
import Input from "./ui/Input";

function safeUrl(value: string) {
  if (
    !/^https?:\/\//.test(value) ||
    /[\s\\]/.test(value) ||
    [...value].some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    )
  )
    return null;
  try {
    const url = new URL(value);
    return url.hostname && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

export default function TaskMaterials({
  detail,
  organizationId,
  locked,
  onWrite,
}: {
  detail: WorkDetail;
  organizationId: string;
  locked: boolean;
  onWrite: (request: WorkWrite) => Promise<void>;
}) {
  const { language } = useConsolePreferences();
  const t = (ka: string, en: string) => (language === "ka" ? ka : en);
  const [editing, setEditing] = useState(false);
  const [links, setLinks] = useState(detail.materialLinks ?? []);
  useEffect(() => {
    if (!editing) return;
    const guard = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [editing]);
  const canEdit =
    detail.canManage && ["open", "offered"].includes(detail.status);
  return (
    <section
      className="mt-4 border-t border-[var(--border)] pt-4"
      aria-label={t("დავალების მასალები", "Task materials")}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-semibold">
          {t("დავალების მასალები", "Task materials")}
        </h3>
        {canEdit && !editing && (
          <Button
            variant="secondary"
            disabled={locked}
            onClick={() => {
              setLinks(detail.materialLinks ?? []);
              setEditing(true);
            }}
          >
            {t("ბმულების მართვა", "Manage links")}
          </Button>
        )}
      </div>
      {!editing && (
        <>
          {!detail.materialLinks?.length && (
            <p className="mt-2 text-[var(--muted)]">
              {t("ბმულები ჯერ არ დამატებულა.", "No links added yet.")}
            </p>
          )}
          <ul className="mt-3 space-y-3">
            {(detail.materialLinks ?? []).map((link, index) => {
              const parsed = safeUrl(link.url);
              return (
                <li key={index} className="min-w-0 break-words">
                  {parsed ? (
                    <a
                      className="text-[var(--primary)] underline break-all"
                      href={link.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      referrerPolicy="no-referrer"
                    >
                      {link.title}{" "}
                      <span className="text-[var(--muted)]">
                        ({parsed.host})
                      </span>
                    </a>
                  ) : (
                    <span>{link.title}</span>
                  )}
                </li>
              );
            })}
          </ul>
          {!!detail.materialLinks?.length && (
            <p className="mt-2 text-sm text-[var(--muted)]">
              {t(
                "გარე ბმულები იხსნება ახალ ჩანართში.",
                "External links open in a new tab.",
              )}
            </p>
          )}
        </>
      )}
      {editing && canEdit && (
        <form
          className="mt-3 space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (
              locked ||
              links.some((link) => !safeUrl(link.url) || !link.title.trim())
            )
              return;
            void onWrite({
              operation: "materials",
              organizationId,
              id: detail.id,
              version: detail.version,
              key: crypto.randomUUID(),
              note: "",
              links: links.map((link) => ({
                title: link.title.trim(),
                url: link.url,
              })),
            });
          }}
        >
          <p className="text-sm text-[var(--muted)]">
            {t(
              "ბმულებს ხედავს ყველა, ვისაც ამ დავალებაზე აქვს წვდომა. მაქსიმუმ 10 ბმული.",
              "Links are shared with everyone who can access this task. Up to 10 links.",
            )}
          </p>
          <fieldset disabled={locked} className="space-y-3 min-w-0">
            {links.map((link, index) => (
              <div
                key={index}
                className="grid gap-2 rounded-lg border border-[var(--border)] p-3"
              >
                <label>
                  {t("ბმულის სახელი", "Link title")} {index + 1}
                  <Input
                    required
                    maxLength={120}
                    value={link.title}
                    onChange={(event) =>
                      setLinks(
                        links.map((item, i) =>
                          i === index
                            ? { ...item, title: event.target.value }
                            : item,
                        ),
                      )
                    }
                  />
                </label>
                <label>
                  {t("მისამართი", "URL")} {index + 1}
                  <Input
                    required
                    type="url"
                    maxLength={2048}
                    value={link.url}
                    placeholder="https://"
                    onChange={(event) =>
                      setLinks(
                        links.map((item, i) =>
                          i === index
                            ? { ...item, url: event.target.value }
                            : item,
                        ),
                      )
                    }
                  />
                </label>
                {link.url && !safeUrl(link.url) && (
                  <p role="alert">
                    {t(
                      "მიუთითეთ HTTP(S) ბმული მომხმარებლის სახელისა და პაროლის გარეშე.",
                      "Use an HTTP(S) URL without a username or password.",
                    )}
                  </p>
                )}
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setLinks(links.filter((_, i) => i !== index))}
                >
                  {t("ბმულის ამოღება", "Remove link")} {index + 1}
                </Button>
              </div>
            ))}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="secondary"
                disabled={links.length >= 10}
                onClick={() => setLinks([...links, { title: "", url: "" }])}
              >
                {t("ბმულის დამატება", "Add link")}
              </Button>
              <Button
                type="submit"
                disabled={links.some(
                  (link) => !safeUrl(link.url) || !link.title.trim(),
                )}
              >
                {t("მასალების შენახვა", "Save materials")}
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => setEditing(false)}
              >
                {t("გაუქმება", "Cancel")}
              </Button>
            </div>
          </fieldset>
        </form>
      )}
    </section>
  );
}
