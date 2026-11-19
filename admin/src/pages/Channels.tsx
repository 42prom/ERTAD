import { useEffect, useRef, useState, type FormEvent } from "react";
import { MessageSquare, Paperclip, Pin, Plus, Search, X } from "lucide-react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import Card from "../components/ui/Card";
import Button from "../components/ui/Button";
import Input from "../components/ui/Input";
import Select from "../components/ui/Select";
import Textarea from "../components/ui/Textarea";
import { useConsolePreferences } from "../components/useConsolePreferences";
import { demoApi } from "../api/demo";
import { REALTIME_EVENT, type RealtimeSignal } from "../api/realtime";
import ChannelRestrictions, {
  type RestrictionTarget,
} from "../components/ChannelRestrictions";
import {
  channelsApi,
  type Channel,
  type ChannelEmoji,
  type ChannelParticipant,
  type ChannelThread,
  type ChannelReport,
  type ChannelWrite,
} from "../api/channels";

const EMOJI_OPTIONS: { key: ChannelEmoji; icon: string; ka: string; en: string }[] = [
  { key: "like", icon: "👍", ka: "მოწონება", en: "Like" },
  { key: "confirm", icon: "✅", ka: "დადასტურება", en: "Confirm" },
  { key: "heart", icon: "❤️", ka: "მხარდაჭერა", en: "Heart" },
  { key: "eyes", icon: "👀", ka: "ვნახე", en: "Seen" },
  { key: "celebrate", icon: "🎉", ka: "მილოცვა", en: "Celebrate" },
];

export default function Channels() {
  const [showRestrictions, setShowRestrictions] = useState(false),
    [inboxRestrictionId, setInboxRestrictionId] = useState(""),
    [restrictionTarget, setRestrictionTarget] = useState<
      RestrictionTarget | undefined
    >(),
    [moderationDirty, setModerationDirty] = useState(false),
    [restrictionRequest, setRestrictionRequest] = useState(0);
  const location = useLocation(),
    navigate = useNavigate(),
    consumed = useRef("");
  const { language } = useConsolePreferences(),
    t = (ka: string, en: string) => (language === "ka" ? ka : en);
  const [params, setParams] = useSearchParams(),
    view = ["active", "archived", "unread"].includes(params.get("view") ?? "")
      ? params.get("view")!
      : "active";
  const [org, setOrg] = useState(""),
    [units, setUnits] = useState<{ id: string; name: string }[]>([]),
    [unitPage, setUnitPage] = useState(1),
    [unitId, setUnitId] = useState("");
  const [rows, setRows] = useState<Channel[]>([]),
    [total, setTotal] = useState(0),
    [page, setPage] = useState(1),
    [selected, setSelected] = useState(""),
    [before, setBefore] = useState(0),
    [thread, setThread] = useState<ChannelThread | null>(null);
  const [reports, setReports] = useState<ChannelReport[]>([]),
    [reportTotal, setReportTotal] = useState(0),
    [reportPage, setReportPage] = useState(1),
    [showReports, setShowReports] = useState(false);
  const [creating, setCreating] = useState(false),
    [title, setTitle] = useState(""),
    [body, setBody] = useState(""),
    [reply, setReply] = useState<{ id: string; seq: number } | null>(null),
    [threadSearch, setThreadSearch] = useState(""),
    [activeSearch, setActiveSearch] = useState(""),
    [participants, setParticipants] = useState<ChannelParticipant[]>([]),
    [attachmentFile, setAttachmentFile] = useState<File | null>(null),
    [previewUrl, setPreviewUrl] = useState<{ url: string; mediaType: string } | null>(null);
  const [confirm, setConfirm] = useState<ChannelWrite | null>(null),
    [pending, setPending] = useState<ChannelWrite | null>(null),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [revision, setRevision] = useState(0),
    [demo, setDemo] = useState(false);
  const serial = useRef(0),
    lock = useRef(false),
    heading = useRef<HTMLHeadingElement>(null);
  const locked = busy || !!pending || moderationDirty,
    dirty = !!body || !!title || !!confirm || !!attachmentFile || locked,
    c = thread?.channel;
  const label = (v: string) =>
    (
      ({
        active: t("მიმდინარე", "Active"),
        archived: t("არქივი", "Archived"),
        unread: t("წაუკითხავი", "Unread"),
        spam: t("სპამი", "Spam"),
        abuse: t("შეურაცხყოფა", "Abuse"),
        privacy: t("პირადი მონაცემები", "Privacy"),
        other: t("სხვა", "Other"),
      }) as Record<string, string>
    )[v] ?? v;
  const failure = (e: unknown) => {
    const status = (e as { response?: { status?: number } }).response?.status;
    return status === 403
      ? t("წვდომა აღარ გაქვთ.", "Access is no longer available.")
      : status === 409
        ? t(
            "მდგომარეობა შეიცვალა. განაახლეთ ჩანაწერები.",
            "State changed. Refresh the records.",
          )
        : status === 429
          ? t(
              "ძალიან ბევრი მოთხოვნაა. ცოტა ხანში სცადეთ.",
              "Too many requests. Try again shortly.",
            )
          : t(
              "მოთხოვნა ვერ შესრულდა. განაახლეთ ან გაიმეორეთ.",
              "The request failed. Refresh or retry.",
            );
  };
  const refresh = () => setRevision((v) => v + 1);
  useEffect(() => {
    let live = true;
    channelsApi
      .contexts()
      .then((v) => {
        if (live) {
          setOrg(v[0]?.id ?? "");
          if (!v.length) setLoading(false);
        }
      })
      .catch((e) => {
        if (live) {
          setError(failure(e));
          setLoading(false);
        }
      });
    demoApi
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
    if (!org) return;
    let live = true;
    channelsApi
      .units(org, unitPage)
      .then((r) => {
        if (live) {
          setUnits(r.items);
          setUnitId((current) =>
            r.items.some((u) => u.id === current)
              ? current
              : (r.items[0]?.id ?? ""),
          );
        }
      })
      .catch(() => {
        if (live) {
          setUnits([]);
          setUnitId("");
        }
      });
    return () => {
      live = false;
    };
  }, [org, unitPage, revision]);
  const readScope1Key = JSON.stringify([
    org,
    view,
    page,
    selected,
    before,
    activeSearch,
    showReports,
    reportPage,
    revision,
  ]);
  const [readScope1, setReadScope1] = useState(readScope1Key);
  // Reconcile scope before committing children, so previous-scope records cannot flash.
  if (readScope1 !== readScope1Key) {
    setReadScope1(readScope1Key);
    setLoading(true);
    setError("");
  }
  useEffect(() => {
    if (!org) return;
    const seq = ++serial.current;
    let live = true;
    const threadLoader = selected
      ? activeSearch && channelsApi.search
        ? channelsApi.search(org, selected, activeSearch)
        : channelsApi.thread(org, selected, before)
      : Promise.resolve(null);
    Promise.all([
      channelsApi.list(org, view, page),
      threadLoader,
      selected && showReports
        ? channelsApi.reports(org, selected, reportPage)
        : Promise.resolve(null),
    ])
      .then(([list, detail, queue]) => {
        if (live && seq === serial.current) {
          setRows(list.items);
          setTotal(list.total);
          setThread(detail);
          setReports(queue?.items ?? []);
          setReportTotal(queue?.total ?? 0);
        }
      })
      .catch((e) => {
        if (live && seq === serial.current) {
          setRows([]);
          setTotal(0);
          setThread(null);
          setReports([]);
          setReportTotal(0);
          setConfirm(null);
          setError(failure(e));
        }
      })
      .finally(() => {
        if (live && seq === serial.current) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [org, view, page, selected, before, activeSearch, showReports, reportPage, revision]);

  useEffect(() => {
    if (!org || !selected || !channelsApi.participants) {
      return;
    }
    let live = true;
    void channelsApi
      .participants(org, selected)
      .then((res) => {
        if (live) setParticipants(res.items);
      })
      .catch(() => {
        if (live) setParticipants([]);
      });
    return () => {
      live = false;
    };
  }, [org, selected]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible" && !lock.current) refresh();
    }, 60_000);
    const focus = () => {
      if (!lock.current) refresh();
    };
    const onRealtime = (event: Event) => {
      const detail = (event as CustomEvent<RealtimeSignal>).detail;
      if (
        detail?.topic === "channel" &&
        !lock.current &&
        (!detail.organizationId || detail.organizationId === org)
      ) {
        refresh();
      }
    };
    window.addEventListener("focus", focus);
    window.addEventListener(REALTIME_EVENT, onRealtime);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", focus);
      window.removeEventListener(REALTIME_EVENT, onRealtime);
    };
  }, [org]);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl.url);
    };
  }, [previewUrl]);
  useEffect(() => {
    if (!dirty) return;
    const guard = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);
  useEffect(() => {
    if (selected && thread) heading.current?.focus();
  }, [selected, !!thread]);
  function open(id: string) {
    if (dirty) return;
    serial.current++;
    setSelected(id);
    setBefore(0);
    setThreadSearch("");
    setActiveSearch("");
    setThread(null);
    setReports([]);
    setShowReports(false);
    setReportPage(1);
    setNotice("");
    setReply(null);
    setAttachmentFile(null);
    setConfirm(null);
    setPreviewUrl(null);
    if (!id) setParticipants([]);
  }
  useEffect(() => {
    const target = location.state?.inbox;
    if (
      !org ||
      dirty ||
      target?.source !== "moderation" ||
      target.organizationId !== org ||
      typeof target.id !== "string" ||
      !/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(target.id) ||
      consumed.current === location.key
    )
      return;
    consumed.current = location.key;
    setRestrictionTarget(undefined);
    setInboxRestrictionId(target.id);
    setShowRestrictions(true);
    navigate(location.pathname + location.search, {
      replace: true,
      state: null,
    });
  }, [org, dirty, location, navigate]);
  useEffect(() => {
    const target = location.state?.channel;
    if (
      !org ||
      dirty ||
      target?.organizationId !== org ||
      typeof target.id !== "string" ||
      !/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(target.id) ||
      consumed.current === location.key
    )
      return;
    consumed.current = location.key;
    open(target.id);
    navigate(location.pathname + location.search, {
      replace: true,
      state: null,
    });
  }, [org, dirty, location, navigate]);
  function command(
    operation: ChannelWrite["operation"],
    extra: Record<string, unknown> = {},
  ): ChannelWrite {
    return {
      operation,
      organizationId: org,
      key: crypto.randomUUID(),
      ...(operation === "create" ? {} : { id: selected }),
      ...extra,
    };
  }
  async function send(input: ChannelWrite, retry = false) {
    if (lock.current || (pending && !retry)) return;
    lock.current = true;
    setBusy(true);
    setPending(structuredClone(input));
    setError("");
    setNotice("");
    try {
      if (demo && ["create", "archive", "resolve"].includes(input.operation))
        await demoApi.stepUp();
      const result = await channelsApi.write(input);
      setPending(null);
      setConfirm(null);
      if (input.operation === "create") {
        setCreating(false);
        setTitle("");
        setShowReports(false);
        setReports([]);
        setReportTotal(0);
        setReportPage(1);
        setSelected(result.id);
        setBefore(0);
        setThread(null);
      }
      if (input.operation === "post") {
        setBody("");
        setReply(null);
        setAttachmentFile(null);
        setBefore(0);
        setActiveSearch("");
      }
      setNotice(t("შენახულია.", "Saved."));
      refresh();
      window.dispatchEvent(new Event("ertad-channels-changed"));
    } catch (e) {
      const status = (e as { response?: { status?: number } }).response?.status;
      if (status && status >= 400 && status < 500) {
        setPending(null);
        setConfirm(null);
      }
      serial.current++;
      setThread(null);
      setReports([]);
      setReportTotal(0);
      setRows([]);
      setTotal(0);
      setShowReports(false);
      setError(failure(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (lock.current) return;
    let attachmentId: string | undefined;
    if (attachmentFile && channelsApi.uploadAttachment) {
      lock.current = true;
      setBusy(true);
      setError("");
      try {
        const uploaded = await channelsApi.uploadAttachment(
          org,
          selected,
          crypto.randomUUID(),
          attachmentFile,
        );
        attachmentId = uploaded.id;
      } catch (err) {
        setError(failure(err));
        lock.current = false;
        setBusy(false);
        return;
      }
      lock.current = false;
      setBusy(false);
    }
    void send(
      command("post", {
        body,
        ...(reply ? { replyId: reply.id } : {}),
        ...(attachmentId ? { attachmentId } : {}),
      }),
    );
  }

  async function openAttachmentPreview(
    attachmentId: string,
    mediaType: "image/png" | "application/pdf",
  ) {
    if (!channelsApi.downloadAttachment || !c) return;
    try {
      const blob = await channelsApi.downloadAttachment(org, c.id, attachmentId);
      const typed = new Blob([blob], { type: mediaType });
      const url = URL.createObjectURL(typed);
      setPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev.url);
        return { url, mediaType };
      });
    } catch (err) {
      setError(failure(err));
    }
  }

  const mentionMatch = /(?:^|\s)@([^\s@]{0,24})$/.exec(body);
  const mentionSuggestions = mentionMatch
    ? participants
        .map((p) => ({
          id: p.id,
          label:
            p.displayName ||
            (p.tag
              ? `${t("მონაწილე", "Participant")} #${p.tag}`
              : `${t("მონაწილე", "Participant")} ${p.id.slice(0, 6)}`),
        }))
        .filter((p) =>
          p.label.toLowerCase().includes(mentionMatch[1].toLowerCase()),
        )
        .slice(0, 5)
    : [];
  return (
    <section className="review-page task-page">
      <header className="flex flex-wrap justify-between items-start gap-4">
        <div>
          <h1>{t("ჯგუფის არხები", "Group channels")}</h1>
          <p>
            {t(
              "დახურული სამუშაო მიმოწერა თქვენი უფლებებისა და იერარქიის ფარგლებში.",
              "Private operational conversations within your permissions and hierarchy.",
            )}
          </p>
        </div>
        {!!units.length && (
          <Button
            disabled={dirty || creating}
            onClick={() => {
              setCreating(true);
              setNotice("");
            }}
          >
            <Plus className="w-4 h-4 mr-2" />
            {t("ახალი არხი", "New channel")}
          </Button>
        )}
      </header>
      <nav
        className="review-tabs"
        aria-label={t("არხების ხედები", "Channel views")}
      >
        {["active", "unread", "archived"].map((v) => (
          <button
            key={v}
            disabled={dirty}
            aria-current={view === v ? "page" : undefined}
            onClick={() => {
              setParams({ view: v });
              setPage(1);
              open("");
            }}
          >
            {label(v)}
          </button>
        ))}
      </nav>
      {org && (
        <Button
          variant="secondary"
          disabled={dirty || showRestrictions}
          onClick={() => {
            setInboxRestrictionId("");
            setRestrictionTarget(undefined);
            setShowRestrictions(true);
          }}
        >
          {t("შეზღუდვები და გასაჩივრება", "Restrictions and appeals")}
        </Button>
      )}
      {showRestrictions && (
        <ChannelRestrictions
          key={
            restrictionTarget
              ? restrictionRequest
              : inboxRestrictionId || "queue"
          }
          organizationId={org}
          demo={demo}
          target={restrictionTarget}
          initialRestrictionId={inboxRestrictionId || undefined}
          onDirty={setModerationDirty}
          onChanged={refresh}
          onClose={() => {
            setShowRestrictions(false);
            setInboxRestrictionId("");
            setRestrictionTarget(undefined);
          }}
        />
      )}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {!thread && (body || title) && !locked && (
        <Button
          variant="secondary"
          onClick={() => {
            setBody("");
            setTitle("");
            setReply(null);
            setCreating(false);
            setConfirm(null);
          }}
        >
          {t("მონახაზის გაუქმება", "Discard draft")}
        </Button>
      )}
      {!!selected && !thread && !dirty && (
        <Button variant="secondary" onClick={() => open("")}>
          {t("არხების სიაში დაბრუნება", "Back to channels")}
        </Button>
      )}
      {pending && !busy && (
        <Card>
          <p>
            {t(
              "შედეგი დაუდასტურებელია. გაიმეორეთ იგივე მოთხოვნა — შეტყობინება არ გაორმაგდება.",
              "The result is unconfirmed. Retry the same request to avoid a duplicate message.",
            )}
          </p>
          <Button onClick={() => void send(pending, true)}>
            {t("იგივე მოთხოვნის გამეორება", "Retry same request")}
          </Button>
        </Card>
      )}
      <div>
        <Button variant="secondary" disabled={busy} onClick={refresh}>
          {t("განახლება", "Refresh")}
        </Button>
        {loading && (
          <span role="status" className="ml-3">
            {t("იტვირთება…", "Loading…")}
          </span>
        )}
      </div>
      {!org && !loading && !error && (
        <Card>
          {t("არხებზე წვდომა არ გაქვთ.", "You do not have access to channels.")}
        </Card>
      )}
      {creating && (
        <Card>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void send(command("create", { unitId, title }));
            }}
          >
            <h2>{t("ახალი არხი", "New channel")}</h2>
            <fieldset disabled={locked} className="space-y-4">
              <Select
                label={t("ჯგუფი ან რეგიონი", "Group or region")}
                value={unitId}
                onChange={(e) => setUnitId(e.target.value)}
                options={units.map((u) => ({ value: u.id, label: u.name }))}
              />
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  disabled={unitPage === 1}
                  onClick={() => setUnitPage((p) => p - 1)}
                >
                  {t("წინა ერთეულები", "Previous units")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={units.length < 25}
                  onClick={() => setUnitPage((p) => p + 1)}
                >
                  {t("სხვა ერთეულები", "More units")}
                </Button>
              </div>
              <Input
                label={t("არხის სახელი", "Channel name")}
                required
                minLength={3}
                maxLength={120}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
              <div className="flex gap-3">
                <Button type="submit" disabled={!unitId}>
                  {t("შექმნა", "Create")}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    setCreating(false);
                    setTitle("");
                  }}
                >
                  {t("გაუქმება", "Cancel")}
                </Button>
              </div>
            </fieldset>
          </form>
        </Card>
      )}
      {!!org && (
        <Card>
          <p>
            {t("არხები", "Channels")}: {total}
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            {rows.map((row) => (
              <Button
                key={row.id}
                variant="ghost"
                disabled={dirty}
                className="justify-start text-left border min-w-0"
                onClick={() => open(row.id)}
                aria-pressed={selected === row.id}
              >
                <MessageSquare className="w-4 h-4 mr-2 shrink-0" />
                <span className="min-w-0 break-words">
                  {row.title}
                  <small className="block">
                    {row.muted
                      ? t("დადუმებულია", "Muted")
                      : `${t("წაუკითხავი", "Unread")}: ${row.unread}`}
                    {row.reports
                      ? ` · ${t("საჩივრები", "Reports")}: ${row.reports}`
                      : ""}
                  </small>
                </span>
              </Button>
            ))}
          </div>
          {!rows.length && !loading && !error && (
            <p>{t("ამ ხედში არხები არ არის.", "No channels in this view.")}</p>
          )}
          <div className="flex gap-3 mt-4">
            <Button
              variant="secondary"
              disabled={page === 1 || dirty}
              onClick={() => setPage((p) => p - 1)}
            >
              {t("წინა", "Previous")}
            </Button>
            <span>{page}</span>
            <Button
              variant="secondary"
              disabled={page * 25 >= total || page >= 1000 || dirty}
              onClick={() => setPage((p) => p + 1)}
            >
              {t("შემდეგი", "Next")}
            </Button>
          </div>
        </Card>
      )}
      {c && (
        <Card>
          {c.workId && (
            <Button
              variant="ghost"
              disabled={dirty}
              onClick={() =>
                navigate("/tasks", {
                  state: {
                    inbox: {
                      source: "work",
                      organizationId: org,
                      id: c.workId,
                    },
                  },
                })
              }
            >
              {t("დავალებაზე დაბრუნება", "Back to task")}
            </Button>
          )}
          <h2 ref={heading} tabIndex={-1}>
            {c.title}
          </h2>
          {c.postingRestriction && (
            <div role="status" className="my-3 space-y-2">
              <p>
                {t(
                  "ამ არხში წერა შეზღუდულია ვადამდე:",
                  "Writing in this channel is restricted until:",
                )}{" "}
                {new Date(c.postingRestriction.expiresAt).toLocaleString(
                  language === "ka" ? "ka-GE" : "en-GB",
                  { hour12: false },
                )}
              </p>
              <p className="whitespace-pre-wrap break-words">
                {c.postingRestriction.reason}
              </p>
              <p>
                {t(
                  "გასაჩივრებისთვის გახსენით „შეზღუდვები და გასაჩივრება“ → „ჩემი შეზღუდვები“.",
                  "To appeal, open Restrictions and appeals → My restrictions.",
                )}
              </p>
            </div>
          )}
          <p>
            {c.archived
              ? t(
                  "არხი არქივშია. ახალი შეტყობინებები გამორთულია.",
                  "Archived channel. New messages are disabled.",
                )
              : t(
                  "ხილულია მხოლოდ არხზე უფლებამოსილი მონაწილეებისთვის.",
                  "Visible only to participants authorized for this channel.",
                )}
          </p>
          <div className="flex flex-wrap gap-2 mb-4">
            <Button
              variant="secondary"
              disabled={locked}
              onClick={() =>
                void send(
                  command("read", {
                    seq: Math.max(
                      c.readSeq,
                      ...thread!.items.map((m) => m.seq),
                    ),
                  }),
                )
              }
            >
              {t(
                "ნაჩვენების წაკითხულად მონიშვნა",
                "Mark displayed messages read",
              )}
            </Button>
            <Button
              variant="secondary"
              disabled={locked}
              onClick={() => void send(command("mute", { muted: !c.muted }))}
            >
              {c.muted
                ? t("დადუმების მოხსნა", "Unmute")
                : t("დადუმება", "Mute")}
            </Button>
            {c.canManage && (
              <Button
                variant="secondary"
                disabled={locked}
                onClick={() =>
                  setConfirm(
                    command("archive", {
                      version: c.version,
                      archived: !c.archived,
                    }),
                  )
                }
              >
                {c.archived
                  ? t("არხის გახსნა", "Reopen channel")
                  : t("არქივში გადატანა", "Archive channel")}
              </Button>
            )}
            {c.canModerate && (
              <Button
                variant="secondary"
                disabled={locked}
                onClick={() => {
                  setShowReports((v) => !v);
                  setReportPage(1);
                }}
              >
                {t("მოდერაცია", "Moderation")}
                {c.reports ? ` (${c.reports})` : ""}
              </Button>
            )}
          </div>
          {c.pinnedMessage && (
            <div className="channel-pinned-banner mb-4" role="region" aria-label={t("მიმაგრებული შეტყობინება", "Pinned message")}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <strong className="inline-flex items-center gap-1 text-xs">
                    <Pin size={14} aria-hidden="true" />
                    {t("მიმაგრებული", "Pinned")} #{c.pinnedMessage.seq}
                  </strong>
                  <p className="text-sm break-words mt-1">{c.pinnedMessage.body}</p>
                </div>
                {(c.canModerate || c.canManage) && !c.archived && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={locked}
                    onClick={() => void send(command("pin", { messageId: null }))}
                  >
                    {t("მოხსნა", "Unpin")}
                  </Button>
                )}
              </div>
            </div>
          )}
          <form
            className="flex flex-wrap items-end gap-2 mb-4"
            onSubmit={(e) => {
              e.preventDefault();
              setActiveSearch(threadSearch.trim());
            }}
          >
            <Input
              label={t("არხში ძებნა", "Search in channel")}
              maxLength={80}
              value={threadSearch}
              disabled={locked}
              onChange={(e) => setThreadSearch(e.target.value)}
            />
            <Button type="submit" variant="secondary" disabled={locked || !threadSearch.trim()}>
              <Search size={16} aria-hidden="true" />
              {t("ძებნა", "Find")}
            </Button>
            {activeSearch && (
              <Button
                type="button"
                variant="ghost"
                disabled={locked}
                onClick={() => {
                  setThreadSearch("");
                  setActiveSearch("");
                }}
              >
                {t("გასუფთავება", "Clear")}
              </Button>
            )}
          </form>
          <ol className="space-y-4" aria-label={t("შეტყობინებები", "Messages")}>
            {thread!.items.map((m) => (
              <li
                key={m.id}
                className="border rounded-lg p-4 border-gray-200"
                data-message-id={m.id}
              >
                <div className="flex flex-wrap justify-between gap-2 text-sm">
                  <strong>
                    {m.mine
                      ? t("თქვენ", "You")
                      : `${t("მონაწილე", "Participant")} #${m.authorTag}`}
                  </strong>
                  <time dateTime={m.createdAt}>
                    {new Date(m.createdAt).toLocaleString(
                      language === "ka" ? "ka-GE" : "en-GB",
                      { hour12: false },
                    )}
                  </time>
                </div>
                {m.replySeq && (
                  <p className="text-sm">
                    {t("პასუხი შეტყობინებაზე", "Reply to message")} #
                    {m.replySeq}
                  </p>
                )}
                <p className="whitespace-pre-wrap break-words">
                  {m.removed
                    ? t("შეტყობინება წაშლილია.", "Message removed.")
                    : m.body}
                </p>
                {!m.removed && m.attachment && (
                  <div className="mt-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void openAttachmentPreview(
                          m.attachment!.id,
                          m.attachment!.mediaType,
                        )
                      }
                    >
                      <Paperclip size={14} aria-hidden="true" />
                      {m.attachment.mediaType === "application/pdf"
                        ? `PDF · ${Math.max(1, Math.round(m.attachment.bytes / 1024))} KB`
                        : `${t("სურათი", "Image")} · ${Math.max(1, Math.round(m.attachment.bytes / 1024))} KB`}
                    </Button>
                  </div>
                )}
                {!m.removed && (
                  <div className="channel-reactions mt-2">
                    {(m.reactions ?? []).map((rx) => {
                      const meta = EMOJI_OPTIONS.find((e) => e.key === rx.emoji);
                      return (
                        <button
                          key={rx.emoji}
                          type="button"
                          className="channel-reaction-pill"
                          data-active={rx.mine}
                          disabled={locked || c.archived || !!c.postingRestriction}
                          aria-label={meta ? t(meta.ka, meta.en) : rx.emoji}
                          onClick={() =>
                            void send(
                              command("react", {
                                messageId: m.id,
                                emoji: rx.emoji,
                              }),
                            )
                          }
                        >
                          <span>{meta?.icon ?? rx.emoji}</span>
                          <span>{rx.count}</span>
                        </button>
                      );
                    })}
                    {!c.archived && !c.postingRestriction && (
                      <div className="channel-react-picker">
                        {EMOJI_OPTIONS.map((opt) => (
                          <button
                            key={opt.key}
                            type="button"
                            className="channel-reaction-add"
                            disabled={locked}
                            title={t(opt.ka, opt.en)}
                            aria-label={`${t(opt.ka, opt.en)} (#${m.seq})`}
                            onClick={() =>
                              void send(
                                command("react", {
                                  messageId: m.id,
                                  emoji: opt.key,
                                }),
                              )
                            }
                          >
                            {opt.icon}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {!m.removed && (
                  <div className="flex flex-wrap gap-2 mt-2">
                    {(c.canModerate || c.canManage) && !c.archived && (
                      <Button
                        variant="ghost"
                        disabled={locked}
                        onClick={() =>
                          void send(
                            command("pin", {
                              messageId:
                                c.pinnedMessage?.id === m.id ? null : m.id,
                            }),
                          )
                        }
                      >
                        <Pin size={14} aria-hidden="true" />
                        {c.pinnedMessage?.id === m.id
                          ? t("მიმაგრების მოხსნა", "Unpin")
                          : t("მიმაგრება", "Pin")}
                      </Button>
                    )}
                    {m.canRestrict && (
                      <Button
                        variant="ghost"
                        disabled={dirty}
                        onClick={() => {
                          setRestrictionRequest((value) => value + 1);
                          setInboxRestrictionId("");
                          setRestrictionTarget({
                            id: c.id,
                            messageId: m.id,
                            participantTag: m.authorTag,
                          });
                          setShowRestrictions(true);
                        }}
                      >
                        {t("წერის შეზღუდვა", "Restrict writing")}
                      </Button>
                    )}
                    {c.canPost && (
                      <Button
                        variant="ghost"
                        disabled={locked}
                        onClick={() => {
                          setReply({ id: m.id, seq: m.seq });
                          document.getElementById("channel-message")?.focus();
                        }}
                      >
                        {t("პასუხი", "Reply")}
                      </Button>
                    )}
                    {m.mine ? (
                      <Button
                        variant="ghost"
                        disabled={locked}
                        onClick={() =>
                          setConfirm(command("remove", { messageId: m.id }))
                        }
                      >
                        {t("წაშლა", "Remove")}
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        disabled={locked}
                        onClick={() =>
                          setConfirm(
                            command("report", {
                              messageId: m.id,
                              category: "spam",
                            }),
                          )
                        }
                      >
                        {t("გასაჩივრება", "Report")}
                      </Button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ol>
          {!thread!.items.length && (
            <p>{t("შეტყობინებები ჯერ არ არის.", "No messages yet.")}</p>
          )}
          <div className="flex flex-wrap gap-3 my-4">
            <Button
              variant="secondary"
              disabled={!thread!.hasOlder || locked}
              onClick={() => setBefore(thread!.items[0].seq)}
            >
              {t("ძველი შეტყობინებები", "Older messages")}
            </Button>
            {before > 0 && (
              <Button
                variant="secondary"
                disabled={locked}
                onClick={() => setBefore(0)}
              >
                {t("ბოლო შეტყობინებები", "Latest messages")}
              </Button>
            )}
          </div>
          {c.canPost && (
            <form onSubmit={submit} className="space-y-3">
              <fieldset disabled={locked} className="space-y-3">
                {reply && (
                  <p>
                    {t("პასუხი", "Reply")} #{reply.seq}{" "}
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => setReply(null)}
                    >
                      {t("პასუხის გაუქმება", "Cancel reply")}
                    </Button>
                  </p>
                )}
                <Textarea
                  id="channel-message"
                  label={t("შეტყობინება", "Message")}
                  required
                  maxLength={4000}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                />
                {mentionSuggestions.length > 0 && (
                  <div
                    className="channel-mention-popover"
                    role="listbox"
                    aria-label={t("მონაწილეთა მონიშვნა", "Mention participants")}
                  >
                    {mentionSuggestions.map((person) => (
                      <button
                        key={person.id}
                        type="button"
                        role="option"
                        aria-selected={false}
                        onClick={() => {
                          const replaced = body.replace(
                            /@([^\s@]{0,24})$/,
                            `@${person.label} `,
                          );
                          setBody(replaced);
                          document.getElementById("channel-message")?.focus();
                        }}
                      >
                        @{person.label}
                      </button>
                    ))}
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-3">
                  <label className="channel-file-picker">
                    <Paperclip size={16} aria-hidden="true" />
                    <span>
                      {attachmentFile
                        ? attachmentFile.name
                        : t("ფაილის მიბმა (PNG/JPEG/PDF)", "Attach PNG/JPEG/PDF")}
                    </span>
                    <input
                      type="file"
                      accept=".png,.jpg,.jpeg,.pdf,image/png,image/jpeg,application/pdf"
                      className="sr-only"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        if (
                          !/\.(png|jpe?g|pdf)$/i.test(file.name) ||
                          file.size < 1 ||
                          file.size > 5 * 1024 * 1024
                        ) {
                          setError(
                            t(
                              "აირჩიეთ PNG/JPEG ან PDF, მაქსიმუმ 5 MiB.",
                              "Choose PNG/JPEG or PDF up to 5 MiB.",
                            ),
                          );
                          e.target.value = "";
                          return;
                        }
                        setError("");
                        setAttachmentFile(file);
                      }}
                    />
                  </label>
                  {attachmentFile && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setAttachmentFile(null)}
                    >
                      <X size={14} aria-hidden="true" />
                      {t("ფაილის მოხსნა", "Remove file")}
                    </Button>
                  )}
                </div>
                <div className="flex gap-3">
                  <Button type="submit" disabled={!body.trim()}>
                    {t("გაგზავნა", "Send")}
                  </Button>
                  {(body || attachmentFile) && (
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => {
                        setBody("");
                        setReply(null);
                        setAttachmentFile(null);
                      }}
                    >
                      {t("მონახაზის გაუქმება", "Discard draft")}
                    </Button>
                  )}
                </div>
              </fieldset>
            </form>
          )}
          {showReports && c.canModerate && (
            <section className="mt-6">
              <h3>{t("განსახილველი საჩივრები", "Reports to review")}</h3>
              {reports.map((r) => (
                <div key={r.id} className="border rounded-lg p-4 mt-3">
                  <p>
                    #{r.seq} · {label(r.category)}
                  </p>
                  <p className="whitespace-pre-wrap break-words">
                    {r.removed
                      ? t("შეტყობინება წაშლილია.", "Message removed.")
                      : r.body}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="secondary"
                      disabled={locked}
                      onClick={() =>
                        setConfirm(
                          command("resolve", {
                            reportId: r.id,
                            outcome: "keep",
                          }),
                        )
                      }
                    >
                      {t("დატოვება", "Keep message")}
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={locked}
                      onClick={() =>
                        setConfirm(
                          command("resolve", {
                            reportId: r.id,
                            outcome: "remove",
                          }),
                        )
                      }
                    >
                      {t("მოდერაციით წაშლა", "Remove reported message")}
                    </Button>
                  </div>
                </div>
              ))}
              {!reports.length && (
                <p>
                  {t(
                    "დამოუკიდებელი განხილვისთვის საჩივრები არ არის.",
                    "No reports eligible for independent review.",
                  )}
                </p>
              )}
              <div className="flex gap-3 mt-3">
                <Button
                  variant="ghost"
                  disabled={reportPage === 1}
                  onClick={() => setReportPage((p) => p - 1)}
                >
                  {t("წინა საჩივრები", "Previous reports")}
                </Button>
                <Button
                  variant="ghost"
                  disabled={reportPage * 25 >= reportTotal}
                  onClick={() => setReportPage((p) => p + 1)}
                >
                  {t("შემდეგი საჩივრები", "Next reports")}
                </Button>
              </div>
            </section>
          )}
        </Card>
      )}
      {confirm && (
        <Card>
          <h2>{t("მოქმედების დადასტურება", "Confirm action")}</h2>
          <p>
            {confirm.operation === "report"
              ? t(
                  "აირჩიეთ საჩივრის მიზეზი. მას სხვა უფლებამოსილი მოდერატორი განიხილავს.",
                  "Choose a report category. Another authorized moderator will review it.",
                )
              : confirm.operation === "remove" || confirm.outcome === "remove"
                ? t(
                    "შეტყობინების ტექსტი წაიშლება. დარჩება მხოლოდ მისი ადგილი მიმოწერაში.",
                    "Message text will be erased. Its position in the conversation will remain.",
                  )
                : t(
                    "ადასტურებთ არჩეულ მოქმედებას?",
                    "Confirm the selected action?",
                  )}
          </p>
          {confirm.operation === "report" && (
            <Select
              label={t("მიზეზი", "Category")}
              value={String(confirm.category)}
              disabled={locked}
              onChange={(e) =>
                setConfirm({ ...confirm, category: e.target.value })
              }
              options={["spam", "abuse", "privacy", "other"].map((value) => ({
                value,
                label: label(value),
              }))}
            />
          )}
          <div className="flex gap-3 mt-4">
            <Button disabled={locked} onClick={() => void send(confirm)}>
              {t("დადასტურება", "Confirm")}
            </Button>
            <Button
              variant="secondary"
              disabled={locked}
              onClick={() => setConfirm(null)}
            >
              {t("გაუქმება", "Cancel")}
            </Button>
          </div>
        </Card>
      )}
      {previewUrl && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-label={t("მიბმული ფაილის ნახვა", "Attachment preview")}
          onClick={(e) => {
            if (e.target === e.currentTarget) setPreviewUrl(null);
          }}
        >
          <div className="attachment-preview-dialog">
            <div className="flex items-center justify-between gap-3 mb-3">
              <strong>{t("მიბმული ფაილი", "Channel attachment")}</strong>
              <div className="flex gap-2">
                <a
                  href={previewUrl.url}
                  download={
                    previewUrl.mediaType === "application/pdf"
                      ? "channel-attachment.pdf"
                      : "channel-attachment.png"
                  }
                  className="workspace-primary-action"
                >
                  {t("ჩამოტვირთვა", "Download")}
                </a>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setPreviewUrl(null)}
                >
                  {t("დახურვა", "Close")}
                </Button>
              </div>
            </div>
            {previewUrl.mediaType === "application/pdf" ? (
              <iframe
                src={previewUrl.url}
                title={t("PDF დოკუმენტი", "PDF attachment")}
                className="w-full h-[70vh] border rounded"
              />
            ) : (
              <img
                src={previewUrl.url}
                alt={t("არხის სურათი", "Channel attachment")}
                className="max-h-[70vh] max-w-full mx-auto rounded object-contain"
              />
            )}
          </div>
        </div>
      )}
    </section>
  );
}
