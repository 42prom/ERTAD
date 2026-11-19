import { useAsyncResource } from "./useAsyncResource";
import { useCallback, useEffect, useRef, useState } from "react";
import { evidenceApi, type EvidenceList } from "../api/evidence";
import { materialFilesApi } from "../api/materialFiles";
import { useConsolePreferences } from "./useConsolePreferences";
import Button from "./ui/Button";
import Input from "./ui/Input";

export default function TaskEvidence({
  organizationId,
  workId,
  version,
  disabled = false,
  material = false,
}: {
  organizationId: string;
  workId: string;
  version: number;
  disabled?: boolean;
  material?: boolean;
}) {
  const { language } = useConsolePreferences(),
    t = (ka: string, en: string) => (language === "ka" ? ka : en);
  const api = material ? materialFilesApi : evidenceApi;
  const title = material
    ? t("ფოტოები და დოკუმენტები", "Photos and documents")
    : t("შესრულების ანგარიშები", "Completion reports");
  const [file, setFile] = useState<File | null>(null),
    [pending, setPending] = useState<{ key: string; file: File } | null>(null),
    [busy, setBusy] = useState(false),
    [revision, setRevision] = useState(0),
    [saved, setSaved] = useState(false),
    [preview, setPreview] = useState<{
      url?: string;
      text?: string;
      mediaType: string;
    } | null>(null);
  const mounted = useRef(false),
    lock = useRef(false),
    input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    return () => {
      if (preview?.url) URL.revokeObjectURL(preview.url);
    };
  }, [preview]);
  const resourceKey = JSON.stringify([
    organizationId,
    workId,
    version,
    revision,
    material,
  ]);
  const load = useCallback(
    () => api.list({ organizationId, workId }),
    [api, organizationId, workId],
  );
  const { data, failed, clear } = useAsyncResource<EvidenceList>(
    resourceKey,
    load,
  );
  const [actionError, setActionError] = useState({ key: "", message: "" });
  const setError = (message: string) =>
    setActionError({ key: resourceKey, message });
  const error =
    (actionError.key === resourceKey ? actionError.message : "") ||
    (failed
      ? material
        ? t(
            "ფაილები მიუწვდომელია ან წვდომა უარყოფილია.",
            "Files are unavailable or access was denied.",
          )
        : t(
            "ანგარიშებზე წვდომა არ გაქვთ ან სერვისი მიუწვდომელია.",
            "Reports are unavailable or access was denied.",
          )
      : "");
  useEffect(() => {
    const refresh = () => {
      if (!pending && !busy && !file) setRevision((v) => v + 1);
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [pending, busy, file]);
  useEffect(() => {
    if (!pending && !file) return;
    const guard = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [pending, file]);
  async function upload() {
    if (lock.current || (!file && !pending)) return;
    const request = pending ?? { key: crypto.randomUUID(), file: file! };
    lock.current = true;
    setBusy(true);
    setPending(request);
    setError("");
    setSaved(false);
    try {
      await api.upload(
        { organizationId, workId, key: request.key },
        request.file,
      );
      if (!mounted.current) return;
      setPending(null);
      setFile(null);
      if (input.current) input.current.value = "";
      setSaved(true);
      setRevision((v) => v + 1);
    } catch (e) {
      if (!mounted.current) return;
      const status = (e as { response?: { status?: number } }).response?.status;
      clear();
      if (status && status >= 400 && status < 500) {
        setPending(null);
        setFile(null);
        if (input.current) input.current.value = "";
      }
      setError(
        status === 403
          ? t(
              "ატვირთვის უფლება აღარ გაქვთ.",
              "Upload permission is no longer available.",
            )
          : status && status >= 400 && status < 500
            ? material
              ? t(
                  "ფაილი უარყოფილია: შეამოწმეთ ფორმატი, ზომა, PDF-ის გვერდები და დავალების მდგომარეობა.",
                  "File rejected: check format, size, PDF pages and task state.",
                )
              : t(
                  "ანგარიში უარყოფილია: გადაამოწმეთ ფორმატი, ზომა და დავალების მდგომარეობა.",
                  "Report rejected: check the format, size and task state.",
                )
            : t(
                "შედეგი დაუდასტურებელია. გაიმეორეთ იგივე ატვირთვა.",
                "Upload result is unconfirmed. Retry the same upload.",
              ),
      );
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function openPreview(id: string, mediaType?: string) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const blob = await api.download({ organizationId, workId, id });
      if (!mounted.current) return;
      if (!material) {
        const text = await blob.text();
        if (!mounted.current) return;
        setPreview((prev) => {
          if (prev?.url) URL.revokeObjectURL(prev.url);
          return { text, mediaType: "text/plain" };
        });
      } else {
        const typedMedia = mediaType === "application/pdf" ? "application/pdf" : "image/png";
        const typed = new Blob([blob], { type: typedMedia });
        const url = URL.createObjectURL(typed);
        setPreview((prev) => {
          if (prev?.url) URL.revokeObjectURL(prev.url);
          return { url, mediaType: typedMedia };
        });
      }
    } catch {
      if (mounted.current) {
        clear();
        setError(
          t(
            "ჩამოტვირთვა ვერ მოხერხდა ან წვდომა გაუქმდა.",
            "Download failed or access was revoked.",
          ),
        );
      }
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function download(id: string, mediaType?: string) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const blob = await api.download({ organizationId, workId, id });
      if (!mounted.current) return;
      const url = URL.createObjectURL(blob),
        anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = material
        ? `task-material.${mediaType === "application/pdf" ? "pdf" : "png"}`
        : "task-report.txt";
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      if (mounted.current) {
        clear();
        setError(
          t(
            "ჩამოტვირთვა ვერ მოხერხდა ან წვდომა გაუქმდა.",
            "Download failed or access was revoked.",
          ),
        );
      }
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function remove(id: string) {
    if (
      lock.current ||
      !window.confirm(
        t("ამოიღოთ ეს ფაილი დავალებიდან?", "Remove this file from the task?"),
      )
    )
      return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await materialFilesApi.remove({ organizationId, workId, id });
      if (mounted.current) setRevision((v) => v + 1);
    } catch {
      if (mounted.current) {
        clear();
        setError(
          t(
            "ამოღება ვერ დადასტურდა. განაახლეთ სია ან გაიმეორეთ ამოღება.",
            "Removal was not confirmed. Refresh or retry removal.",
          ),
        );
      }
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <section className="border-t mt-4 pt-4 space-y-3" aria-label={title}>
      <h3 className="font-semibold">{title}</h3>
      <p>
        {material
          ? t(
              "PNG/JPEG ან PDF, მაქსიმუმ 5 MiB; PDF — 5 გვერდამდე. ფოტოებიდან იშლება მეტამონაცემები. PDF გარდაიქმნება გვერდების გამოსახულებებად: ტექსტი აღარ მოინიშნება, ფორმები და ბმულები არ იმუშავებს. ინახება 90 დღე და ხელმისაწვდომია დავალების ყველა მკითხველისთვის.",
              "PNG/JPEG or PDF, up to 5 MiB; PDFs up to 5 pages. Photo metadata is removed. PDFs become page images: text selection, forms and links are lost. Retained for 90 days and shared with all task readers.",
            )
          : t(
              "UTF-8 .txt, მაქსიმუმ 64 KiB. ინახება 90 დღე. ანგარიში თავისთავად შესრულებას არ ადასტურებს.",
              "UTF-8 .txt, up to 64 KiB. Retained for 90 days. A report does not itself verify completion.",
            )}
      </p>
      {error && <p role="alert">{error}</p>}
      {saved && (
        <p role="status">
          {material
            ? t("ფაილი აიტვირთა.", "File uploaded.")
            : t("ანგარიში აიტვირთა.", "Report uploaded.")}
        </p>
      )}
      {!data && !error && <p role="status">{t("იტვირთება…", "Loading…")}</p>}
      <Button
        variant="secondary"
        disabled={busy || !!pending || disabled}
        onClick={() => setRevision((v) => v + 1)}
      >
        {material
          ? t("ფაილების განახლება", "Refresh files")
          : t("ანგარიშების განახლება", "Refresh reports")}
      </Button>
      {data?.canUpload && (
        <Input
          ref={input}
          type="file"
          accept={
            material
              ? ".png,.jpg,.jpeg,.pdf,image/png,image/jpeg,application/pdf"
              : ".txt,text/plain"
          }
          disabled={busy || !!pending || disabled}
          label={
            material
              ? t("ფოტო ან PDF", "Photo or PDF")
              : t("ტექსტური ანგარიში", "Text report")
          }
          onChange={(e) => {
            setSaved(false);
            const value = e.target.files?.[0];
            if (
              value &&
              (!(material
                ? /\.(png|jpe?g|pdf)$/i.test(value.name)
                : value.name.toLowerCase().endsWith(".txt")) ||
                value.size < 1 ||
                value.size > (material ? 5 * 1024 * 1024 : 65536))
            ) {
              setFile(null);
              e.target.value = "";
              setError(
                material
                  ? t(
                      "აირჩიეთ PNG/JPEG ან PDF, მაქსიმუმ 5 MiB.",
                      "Choose PNG/JPEG or PDF up to 5 MiB.",
                    )
                  : t(
                      "აირჩიეთ .txt ფაილი, მაქსიმუმ 64 KiB.",
                      "Choose a .txt file up to 64 KiB.",
                    ),
              );
              return;
            }
            setError("");
            setFile(value ?? null);
          }}
        />
      )}
      {(file || pending) && (
        <Button disabled={busy || disabled} onClick={() => void upload()}>
          {pending
            ? t("იგივე ატვირთვის გამეორება", "Retry same upload")
            : material
              ? t("ფაილის ატვირთვა", "Upload file")
              : t("ანგარიშის ატვირთვა", "Upload report")}
        </Button>
      )}
      {data && !data.items.length && (
        <p>
          {material
            ? t("ფაილები ჯერ არ არის.", "No files yet.")
            : t("ანგარიშები ჯერ არ არის.", "No reports yet.")}
        </p>
      )}
      {data?.items.map((item) => (
        <div
          key={item.id}
          className="border-t py-3 flex flex-wrap items-center gap-3"
        >
          <span>
            {material
              ? item.mediaType === "application/pdf"
                ? "PDF"
                : t("ფოტო", "Photo")
              : item.mine
                ? t("ჩემი ანგარიში", "My report")
                : t("მონაწილის ანგარიში", "Participant report")}{" "}
            · {item.bytes} B ·{" "}
            {new Date(item.createdAt).toLocaleDateString(
              language === "ka" ? "ka-GE" : "en-GB",
            )}
          </span>
          <span>
            {t("შენახვის ვადა", "Retained until")}:{" "}
            {new Date(item.expiresAt).toLocaleDateString(
              language === "ka" ? "ka-GE" : "en-GB",
            )}
          </span>
          <Button
            variant="ghost"
            disabled={busy || disabled}
            onClick={() => void openPreview(item.id, item.mediaType)}
          >
            {t("ნახვა", "Preview")}
          </Button>
          <Button
            variant="secondary"
            disabled={busy || disabled}
            onClick={() => void download(item.id, item.mediaType)}
          >
            {material
              ? t("ფაილის ჩამოტვირთვა", "Download file")
              : t("ანგარიშის ჩამოტვირთვა", "Download report")}
          </Button>
          {material && data.canRemove && (
            <Button
              variant="secondary"
              disabled={busy || !!pending || disabled}
              onClick={() => void remove(item.id)}
            >
              {t("ფაილის ამოღება", "Remove file")}
            </Button>
          )}
        </div>
      ))}
      {preview && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-label={t("ფაილის ნახვა", "File preview")}
          onClick={(e) => {
            if (e.target === e.currentTarget) setPreview(null);
          }}
        >
          <div className="attachment-preview-dialog">
            <div className="flex items-center justify-between gap-3 mb-3">
              <strong>{title}</strong>
              <Button variant="secondary" size="sm" onClick={() => setPreview(null)}>
                {t("დახურვა", "Close")}
              </Button>
            </div>
            {preview.text !== undefined ? (
              <pre className="whitespace-pre-wrap break-words text-sm p-3 border rounded max-h-[70vh] overflow-auto">
                {preview.text}
              </pre>
            ) : preview.mediaType === "application/pdf" ? (
              <iframe
                src={preview.url}
                title={t("PDF დოკუმენტი", "PDF document")}
                className="w-full h-[70vh] border rounded"
              />
            ) : (
              <img
                src={preview.url}
                alt={t("მტკიცებულების ფოტო", "Evidence image")}
                className="max-h-[70vh] max-w-full mx-auto rounded object-contain"
              />
            )}
          </div>
        </div>
      )}
    </section>
  );
}
