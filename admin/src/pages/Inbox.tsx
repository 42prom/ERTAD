import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { inboxApi, type InboxItem, type InboxPage } from "../api/inbox";
import { useConsolePreferences } from "../components/useConsolePreferences";
import Card from "../components/ui/Card";
import Button from "../components/ui/Button";
import Select from "../components/ui/Select";

export default function Inbox() {
  const { language } = useConsolePreferences(),
    t = (ka: string, en: string) => (language === "ka" ? ka : en),
    navigate = useNavigate();
  const [params, setParams] = useSearchParams(),
    [org, setOrg] = useState(""),
    [data, setData] = useState<InboxPage | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [revision, setRevision] = useState(0),
    [busy, setBusy] = useState("");
  const generation = useRef(0),
    lock = useRef(false);
  const sources = [
      "all",
      "membership",
      "unit",
      "work",
      "collective",
      "decision",
      "moderation",
      "contribution",
      "event",
    ],
    views = ["action", "unread", "all"];
  const source = sources.includes(params.get("source") ?? "")
      ? params.get("source")!
      : "all",
    view = views.includes(params.get("view") ?? "")
      ? params.get("view")!
      : "action";
  const rawPage = Number(params.get("page") ?? 1),
    page =
      Number.isInteger(rawPage) && rawPage >= 1 && rawPage <= 1000
        ? rawPage
        : 1;
  const label = (key: string) =>
    (
      ({
        all: t("ყველა", "All"),
        action: t("ჩემი მოქმედებაა საჭირო", "Needs my action"),
        unread: t("წაუკითხავი", "Unread"),
        membership: t("წევრობა და პოზიციები", "Membership and positions"),
        unit: t("ჯგუფები და რეგიონები", "Groups and regions"),
        work: t("დავალებები", "Tasks"),
        event: t("ღონისძიებები", "Events"),
        event_follow_up: t("მოახლოებული ღონისძიება", "Upcoming event"),
        decision: t("პულები და გამოკითხვები", "Polls and surveys"),
        decision_participate: t("მონაწილეობა", "Participate"),
        moderation: t("არხების მოდერაცია", "Channel moderation"),
        contribution: t(
          "კონტრიბუცია და ჯილდოები",
          "Contribution and recognition",
        ),
        contribution_record: t("ქულების აღრიცხვა", "Recognition record"),
        award: t("ქულები მინიჭებულია", "Points awarded"),
        reversal: t("ქულები შესწორებულია", "Points corrected"),
        cap_reached: t("პერიოდის ზღვარი მიღწეულია", "Period cap reached"),
        channel_restriction: t(
          "წერის შეზღუდვა და გასაჩივრება",
          "Writing restriction and appeal",
        ),
        review_appeal: t("საჩივრის განხილვა", "Review appeal"),
        restricted: t("წერა შეზღუდულია", "Writing restricted"),
        appealed: t("გასაჩივრებულია", "Appealed"),
        lifted: t("შეზღუდვა მოხსნილია", "Restriction lifted"),
        upheld: t("შეზღუდვა ძალაშია", "Restriction upheld"),
        closed: t("დასრულებული", "Closed"),
        collective: t(
          "ადმინისტრაციული დამტკიცებები",
          "Administrative approvals",
        ),
        review: t("განხილვა", "Review"),
        accept: t("შემოთავაზებული დავალების განხილვა", "Review task offer"),
        verify: t("შესრულების შემოწმება", "Verify completion"),
        qualification: t("კვალიფიკაციის შემოწმება", "Review qualification"),
        receive: t("რესურსის მიღება", "Confirm provision"),
        assign: t("მონაწილეების შერჩევა", "Review applicants"),
        participate: t("მუშაობის გაგრძელება", "Continue work"),
        follow_up: t("მდგომარეობის გადამოწმება", "Follow up"),
        pending: t("დასადასტურებელი", "Pending"),
        approved: t("დამტკიცებული", "Approved"),
        rejected: t("უარყოფილი", "Rejected"),
        expired: t("ვადაგასული", "Expired"),
        withdrawn: t("გამოთხოვილი", "Withdrawn"),
        open: t("მიმდინარე", "Open"),
        offered: t("მისაღები", "Offered"),
        completed: t("დასრულებული", "Completed"),
        cancelled: t("გაუქმებული", "Cancelled"),
        directive: t("დირექტივა", "Directive"),
        position_create: t("ახალი პოზიცია", "New position"),
        position_revision: t("პოზიციის ახალი ვერსია", "New position version"),
        position_retire: t("პოზიციის გამოყენებიდან ამოღება", "Retire position"),
        policy: t("თანხმობის წესი", "Approval policy"),
        points_rule: t("ქულების წესი", "Points rule"),
        points_award: t("პირადი ჯილდო", "Individual recognition"),
        points_reverse: t("ქულების შესწორება", "Points correction"),
        funding_target: t("ბიუჯეტი", "Funding target"),
        funding_receipt: t("თანხის მიღება", "Funding receipt"),
        funding_expense: t("ხარჯი", "Expense"),
        funding_reserve: t("თანხის დაჯავშნა", "Reservation"),
        funding_release: t("ჯავშნის გამოთავისუფლება", "Reservation release"),
        funding_refund: t("თანხის დაბრუნება", "Refund"),
        funding_reverse: t("ხარჯის შესწორება", "Expense reversal"),
        funding_envelope: t("ჯგუფის ბიუჯეტი", "Child budget"),
        funding_publish: t(
          "ფინანსური შეჯამების გამოქვეყნება",
          "Publish funding summary",
        ),
      }) as Record<string, string>
    )[key] ?? key;
  const refresh = () => {
    generation.current++;
    setRevision((v) => v + 1);
  };
  const readScope1Key = JSON.stringify([view, source, page]);
  const [readScope1, setReadScope1] = useState(readScope1Key);
  // Reconcile scope before committing children, so previous-scope records cannot flash.
  if (readScope1 !== readScope1Key) {
    setReadScope1(readScope1Key);
    setLoading(true);
    setData(null);
    setError("");
  }
  useEffect(() => {
    let live = true;
    const seq = ++generation.current;
    inboxApi
      .summary()
      .then(async (summary) => {
        const id = summary.contexts[0]?.id ?? "";
        if (!live || seq !== generation.current) return;
        setOrg(id);
        const result = id
          ? await inboxApi.list({ organizationId: id, view, source, page })
          : null;
        if (live && seq === generation.current) setData(result);
      })
      .catch((e) => {
        if (live && seq === generation.current) {
          setOrg("");
          if ((e as { response?: { status?: number } })?.response?.status === 403) {
            setData(null);
          }
          setError(
            t(
              "შეტყობინებები ვერ ჩაიტვირთა. განაახლეთ გვერდი.",
              "Could not load the inbox. Refresh to retry.",
            ),
          );
        }
      })
      .finally(() => {
        if (live && seq === generation.current) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [view, source, page, revision]);
  useEffect(() => {
    const update = () => {
      generation.current++;
      setRevision((v) => v + 1);
    };
    const timer = window.setInterval(update, 60000);
    for (const event of [
      "focus",
      "ertad-reviews-changed",
      "ertad-work-changed",
      "ertad-inbox-changed",
    ])
      window.addEventListener(event, update);
    return () => {
      clearInterval(timer);
      for (const event of [
        "focus",
        "ertad-reviews-changed",
        "ertad-work-changed",
        "ertad-inbox-changed",
      ])
        window.removeEventListener(event, update);
    };
  }, []);
  function filter(key: string, value: string) {
    const next = new URLSearchParams(params);
    next.set(key, value);
    if (key !== "page") next.delete("page");
    setParams(next);
  }
  async function mark(item: InboxItem) {
    if (lock.current) return;
    lock.current = true;
    setBusy(item.source + item.id);
    setError("");
    try {
      await inboxApi.read({
        organizationId: org,
        source: item.source,
        id: item.id,
        version: item.version,
      });
      refresh();
      window.dispatchEvent(new Event("ertad-inbox-changed"));
    } catch {
      generation.current++;
      setData(null);
      setError(
        t(
          "წაკითხვის შედეგი ვერ დადასტურდა. განაახლეთ სია; საჭიროების შემთხვევაში მონიშვნა შეგიძლიათ გაიმეოროთ.",
          "Read status could not be confirmed. Refresh the list and retry if needed.",
        ),
      );
    } finally {
      lock.current = false;
      setBusy("");
    }
  }
  function open(item: InboxItem) {
    navigate(
      {
        membership: "/reviews",
        unit: "/units",
        work: "/tasks",
        collective: "/approvals",
        decision: "/decisions",
        moderation: "/channels",
        contribution: "/contribution",
        event: "/events",
      }[item.source],
      {
        state: {
          inbox: { organizationId: org, source: item.source, id: item.id },
        },
      },
    );
  }
  return (
    <section className="review-page">
      <header className="page-header">
        <h1>{t("შემოსული მოთხოვნები", "Inbox")}</h1>
        <p>
          {t(
            "თქვენი იერარქიის მოთხოვნები, დავალებები და შეტყობინებები ერთ ადგილას. წაკითხვა მოთხოვნას არ ამტკიცებს.",
            "Requests, tasks and notifications in your scope. Marking an item read does not approve it.",
          )}
        </p>
      </header>
      <div className="flex flex-wrap gap-3 items-end">
        <div className="w-full max-w-sm">
          <Select
            label={t("კატეგორია", "Category")}
            value={source}
            onChange={(e) => filter("source", e.target.value)}
            options={sources.map((value) => ({ value, label: label(value) }))}
          />
        </div>
        <Button variant="secondary" disabled={!!busy} onClick={refresh}>
          {t("განახლება", "Refresh")}
        </Button>
        {source !== "all" && (
          <Button
            variant="secondary"
            onClick={() => {
              setParams({ view });
            }}
          >
            {t("ფილტრის გასუფთავება", "Reset filter")}
          </Button>
        )}
      </div>
      <nav
        className="review-tabs"
        aria-label={t("შემოსული მოთხოვნების ხედები", "Inbox views")}
      >
        {views.map((v) => (
          <button
            key={v}
            type="button"
            aria-current={view === v ? "page" : undefined}
            onClick={() => filter("view", v)}
          >
            {label(v)}
          </button>
        ))}
      </nav>
      {error && <p role="alert">{error}</p>}
      {loading && <p role="status">{t("იტვირთება…", "Loading…")}</p>}
      {!loading && !error && !org && (
        <Card>
          {t(
            "ამ განყოფილებაზე წვდომა არ გაქვთ.",
            "You do not have access to this area.",
          )}
        </Card>
      )}
      {data && (
        <Card>
          <p>
            {t("ჩანაწერები", "Records")}: {data.total} ·{" "}
            {t("წაუკითხავი", "Unread")}: {data.unread} ·{" "}
            {t("ჩემი მოქმედებაა საჭირო", "Needs my action")}:{" "}
            {data.actionRequired}
          </p>
          {data.items.length ? (
            <div
              className="review-table-scroll"
              tabIndex={0}
              role="region"
              aria-label={t("მოთხოვნების ცხრილი", "Requests table")}
            >
              <table className="w-full text-left">
                <thead>
                  <tr>
                    <th>{t("მოთხოვნა", "Item")}</th>
                    <th>{t("ერთეული", "Unit")}</th>
                    <th>{t("მდგომარეობა", "Status")}</th>
                    <th>{t("მოქმედება", "Action")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((item) => (
                    <tr
                      key={item.source + item.id}
                      data-inbox-id={item.id}
                      className="border-t align-top"
                    >
                      <td className="py-3 pr-3">
                        <Button
                          variant="ghost"
                          className="min-h-11 text-left font-semibold justify-start"
                          onClick={() => open(item)}
                        >
                          {item.source === "collective" ||
                          item.source === "moderation" ||
                          item.source === "contribution"
                            ? label(item.title)
                            : item.title}
                        </Button>
                        <p>
                          {label(item.source)}
                          {item.unread ? ` · ${label("unread")}` : ""}
                        </p>
                        <p className="text-sm">
                          {item.source === "contribution"
                            ? new Date(item.updatedAt).toLocaleDateString(
                                language === "ka" ? "ka-GE" : "en-GB",
                                { timeZone: "UTC" },
                              )
                            : new Date(item.updatedAt).toLocaleString(
                                language === "ka" ? "ka-GE" : "en-GB",
                                { hour12: false },
                              )}
                        </p>
                      </td>
                      <td className="py-3 pr-3">{item.unitName ?? "—"}</td>
                      <td className="py-3 pr-3">
                        {label(item.status)}
                        {item.deadline && (
                          <p>
                            {t("ვადა", "Due")}:{" "}
                            {new Date(item.deadline).toLocaleDateString(
                              language === "ka" ? "ka-GE" : "en-GB",
                            )}
                          </p>
                        )}
                      </td>
                      <td className="py-3">
                        <div className="flex flex-wrap gap-2">
                          <Button
                            variant="secondary"
                            onClick={() => open(item)}
                          >
                            {item.action
                              ? label(item.action)
                              : t("ნახვა", "View")}
                          </Button>
                          {item.unread && (
                            <Button
                              variant="secondary"
                              disabled={!!busy}
                              onClick={() => void mark(item)}
                            >
                              {busy === item.source + item.id
                                ? t("ინახება…", "Saving…")
                                : t("წაკითხულად მონიშვნა", "Mark as read")}
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="py-4">
              {t("ამ ხედში მოთხოვნები არ არის.", "No items in this view.")}
            </p>
          )}
          <div className="flex gap-3 items-center mt-4">
            <Button
              variant="secondary"
              disabled={page <= 1 || !!busy}
              onClick={() => filter("page", String(page - 1))}
            >
              {t("წინა", "Previous")}
            </Button>
            <span>{page}</span>
            <Button
              variant="secondary"
              disabled={page * 25 >= data.total || page >= 1000 || !!busy}
              onClick={() => filter("page", String(page + 1))}
            >
              {t("შემდეგი", "Next")}
            </Button>
          </div>
        </Card>
      )}
    </section>
  );
}
