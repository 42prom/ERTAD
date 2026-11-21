import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Users, ArrowLeft, Download, RefreshCw } from "lucide-react";
import { downloadSafeCsv } from "../utils/safeCsv";
import {
  membersApi,
  type DirectoryMember,
  type MemberDetail,
  type MemberPage,
  type MemberUnit,
} from "../api/members";
import { useConsolePreferences } from "../components/useConsolePreferences";
import Card from "../components/ui/Card";
import Button from "../components/ui/Button";
import Input from "../components/ui/Input";
import Select from "../components/ui/Select";
import MembershipChange from "../components/MembershipChange";

export default function Members() {
  const { language } = useConsolePreferences(),
    navigate = useNavigate();
  const t = (ka: string, en: string) => (language === "ka" ? ka : en);
  const [org, setOrg] = useState(""),
    [access, setAccess] = useState<boolean | null>(null),
    [revision, setRevision] = useState(0);
  const [search, setSearch] = useState(""),
    [role, setRole] = useState(""),
    [query, setQuery] = useState({ search: "", role: "" }),
    [status, setStatus] = useState("active");
  const [scope, setScope] = useState<MemberUnit | null>(null),
    [unitSearch, setUnitSearch] = useState(""),
    [unitQuery, setUnitQuery] = useState(""),
    [unitPage, setUnitPage] = useState(1);
  const [units, setUnits] = useState<MemberPage<MemberUnit> | null>(null),
    [unitError, setUnitError] = useState(false);
  const [rows, setRows] = useState<MemberPage<DirectoryMember> | null>(null),
    [page, setPage] = useState(1),
    [selected, setSelected] = useState(""),
    [detail, setDetail] = useState<MemberDetail | null>(null),
    [revealedMemberId, setRevealedMemberId] = useState(""),
    [workPage, setWorkPage] = useState(1);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const failure = (e: unknown) =>
    (e as { response?: { status?: number } }).response?.status === 403
      ? t(
          "ამ მონაცემებზე წვდომა აღარ გაქვთ.",
          "You no longer have access to these records.",
        )
      : t(
          "მონაცემები ვერ ჩაიტვირთა. სცადეთ ხელახლა.",
          "Could not load records. Please retry.",
        );
  const readScope1Key = JSON.stringify([revision]);
  const [readScope1, setReadScope1] = useState(readScope1Key);
  // Reconcile scope before committing children, so previous-scope records cannot flash.
  if (readScope1 !== readScope1Key) {
    setReadScope1(readScope1Key);
    setLoading(true);
    setError("");
    setRows(null);
    setDetail(null);
  }
  useEffect(() => {
    let live = true;
    membersApi
      .contexts()
      .then((c) => {
        if (live) {
          setAccess(c.length > 0);
          setOrg(c[0]?.id ?? "");
          if (!c.length) setLoading(false);
        }
      })
      .catch((e) => {
        if (live) {
          setAccess(null);
          setOrg("");
          setError(failure(e));
          setLoading(false);
        }
      });
    return () => {
      live = false;
    };
  }, [revision]);
  useEffect(() => {
    if (query.search === search && query.role === role) return;
    const timer = setTimeout(() => {
      setQuery({ search, role });
      setPage(1);
      setSelected("");
    }, 300);
    return () => clearTimeout(timer);
  }, [search, role, query]);
  useEffect(() => {
    if (unitQuery === unitSearch) return;
    const timer = setTimeout(() => {
      setUnitQuery(unitSearch);
      setUnitPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [unitSearch, unitQuery]);
  const readScope2Key = JSON.stringify([org, unitQuery, unitPage, revision]);
  const [readScope2, setReadScope2] = useState(readScope2Key);
  // Reconcile scope before committing children, so previous-scope records cannot flash.
  if (readScope2 !== readScope2Key) {
    setReadScope2(readScope2Key);
    setUnits(null);
    setUnitError(false);
  }
  useEffect(() => {
    if (!org) return;
    let live = true;
    membersApi
      .units(org, unitQuery, unitPage)
      .then((v) => {
        if (live) setUnits(v);
      })
      .catch(() => {
        if (live) setUnitError(true);
      });
    return () => {
      live = false;
    };
  }, [org, unitQuery, unitPage, revision]);
  const readScope3Key = JSON.stringify([
    org,
    scope?.id,
    query,
    status,
    page,
    selected,
    workPage,
    revision,
  ]);
  const [readScope3, setReadScope3] = useState(readScope3Key);
  // Reconcile scope before committing children, so previous-scope records cannot flash.
  if (readScope3 !== readScope3Key) {
    setReadScope3(readScope3Key);
    setLoading(true);
    setError("");
    setRows(null);
    setDetail(null);
  }
  useEffect(() => {
    if (!org) return;
    let live = true;
    const read = selected
      ? membersApi.detail(org, selected, scope?.id, workPage)
      : membersApi.list({
          organizationId: org,
          unitId: scope?.id,
          ...query,
          status,
          page,
        });
    read
      .then((v) => {
        if (live) {
          if ("memberships" in v) setDetail(v);
          else setRows(v);
        }
      })
      .catch((e) => {
        if (live) {
          setError(failure(e));
          if (
            (e as { response?: { status?: number } }).response?.status === 403 &&
            selected
          ) {
            setDetail(null);
          }
        }
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [org, scope?.id, query, status, page, selected, workPage, revision]);
  useEffect(() => {
    if (detail) heading.current?.focus();
  }, [detail]);
  useEffect(() => {
    const refresh = () => {
      setRevision((v) => v + 1);
    };
    const timer = window.setInterval(refresh, 60000);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, []);
  const label = (value: string) =>
    ({
      active: t("მოქმედი", "Active"),
      suspended: t("შეჩერებული", "Suspended"),
      ended: t("დასრულებული", "Ended"),
      expired: t("ვადაგასული", "Expired"),
      scheduled: t("დაგეგმილი", "Scheduled"),
      inactive: t("უფლებები არააქტიურია", "Authority inactive"),
      applied: t("განაცხადი", "Applied"),
      reserved: t("რეზერვში", "Reserved"),
      assigned: t("დანიშნული", "Assigned"),
      in_progress: t("მიმდინარეობს", "In progress"),
      submitted: t("დასადასტურებელი", "Awaiting verification"),
      verified: t("დადასტურებული", "Verified"),
      withdrawn: t("გამოთხოვილი", "Withdrawn"),
      rejected: t("უარყოფილი", "Rejected"),
      no_show: t("არ გამოცხადდა", "No-show"),
    })[value] ?? value;
  const name = (m: DirectoryMember) =>
    m.displayName ?? t("წევრი", "Member") + " " + m.id.slice(0, 8);
  const date = (value: string | null) =>
    value
      ? new Date(value).toLocaleDateString(
          language === "ka" ? "ka-GE" : "en-GB",
        )
      : t("ვადის გარეშე", "No end date");
  const refresh = () => {
    setRows(null);
    setDetail(null);
    setRevision((v) => v + 1);
  };
  const pagination = (p: MemberPage<unknown>, change: (p: number) => void) => (
    <div className="mt-4 flex flex-wrap items-center gap-3">
      <Button
        variant="secondary"
        disabled={loading || p.page <= 1}
        onClick={() => change(p.page - 1)}
      >
        {t("წინა", "Previous")}
      </Button>
      <span>
        {p.page} / {Math.max(1, Math.ceil(p.total / p.pageSize))}
      </span>
      <Button
        variant="secondary"
        disabled={loading || p.page * p.pageSize >= p.total}
        onClick={() => change(p.page + 1)}
      >
        {t("შემდეგი", "Next")}
      </Button>
    </div>
  );
  return (
    <div className="review-page members-page">
      <div className="flex flex-wrap justify-between items-start gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Users size={24} />
            {t("წევრები", "Members")}
          </h1>
          <p className="text-[var(--muted)]">
            {t(
              "თქვენი იერარქიის წევრობა, მონაწილეობა და ნებადართული ქულები.",
              "Membership, participation and permitted points within your hierarchy.",
            )}
          </p>
        </div>
        <Button variant="secondary" disabled={loading} onClick={refresh}>
          <RefreshCw size={18} />
          {t("განახლება", "Refresh")}
        </Button>
      </div>
      {error && <p role="alert">{error}</p>}
      {access === false && (
        <Card>
          {t(
            "წევრების სიის ნახვის უფლება არ გაქვთ.",
            "You do not have permission to browse members.",
          )}
        </Card>
      )}
      {access && (
        <>
          {!selected && (
            <Card>
              <div className="grid gap-4 md:grid-cols-2">
                <Input
                  label={t(
                    "სახელი ან წევრის სრული კოდი",
                    "Name or full member code",
                  )}
                  value={search}
                  maxLength={120}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <Input
                  label={t("როლის ძიება", "Search role")}
                  value={role}
                  maxLength={120}
                  onChange={(e) => setRole(e.target.value)}
                />
                <Select
                  label={t("წევრობის სტატუსი", "Membership status")}
                  value={status}
                  onChange={(e) => {
                    setStatus(e.target.value);
                    setPage(1);
                  }}
                  options={[
                    { value: "all", label: t("ყველა", "All") },
                    ...[
                      "active",
                      "suspended",
                      "ended",
                      "expired",
                      "scheduled",
                      "inactive",
                    ].map((value) => ({ value, label: label(value) })),
                  ]}
                />
                <div>
                  <Input
                    label={t(
                      "რეგიონის / ჯგუფის ძიება",
                      "Search region / group",
                    )}
                    value={unitSearch}
                    maxLength={120}
                    onChange={(e) => setUnitSearch(e.target.value)}
                  />
                  <Select
                    label={t(
                      "ერთეული და დაქვემდებარება",
                      "Unit and descendants",
                    )}
                    value={scope?.id ?? ""}
                    onChange={(e) => {
                      setScope(
                        units?.items.find((u) => u.id === e.target.value) ??
                          null,
                      );
                      setPage(1);
                    }}
                    options={[
                      {
                        value: "",
                        label: t("ჩემი სრული ფარგლები", "My full scope"),
                      },
                      ...(scope && !units?.items.some((u) => u.id === scope.id)
                        ? [scope]
                        : []),
                      ...(units?.items ?? []),
                    ].map((u) =>
                      "value" in u ? u : { value: u.id, label: u.name },
                    )}
                  />
                  {unitError && (
                    <p role="alert">
                      {t(
                        "ერთეულები ვერ ჩაიტვირთა. გამოიყენეთ განახლება.",
                        "Could not load units. Use Refresh.",
                      )}
                    </p>
                  )}
                  {units &&
                    units.total > units.pageSize &&
                    pagination(units, setUnitPage)}
                </div>
              </div>
              <Button
                className="mt-3"
                variant="ghost"
                onClick={() => {
                  setSearch("");
                  setRole("");
                  setStatus("active");
                  setScope(null);
                  setUnitSearch("");
                  setPage(1);
                }}
              >
                {t("ფილტრების გასუფთავება", "Reset filters")}
              </Button>
            </Card>
          )}
          {loading && <p role="status">{t("იტვირთება…", "Loading…")}</p>}
          {!selected && rows && (
            <Card>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p>
                  {t("წევრების რაოდენობა", "Members found")}: {rows.total}
                </p>
                {rows.items.length > 0 && (
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      downloadSafeCsv(
                        `ertad-members-page-${page}.csv`,
                        ["Member", "Roles", "Visible Points"],
                        rows.items.map((m) => [
                          name(m),
                          m.memberships
                            .map(
                              (x) =>
                                `${x.unitName} - ${x.positionName} (${x.status})`,
                            )
                            .join("; "),
                          m.points ?? "Restricted",
                        ]),
                      )
                    }
                  >
                    <Download size={15} aria-hidden="true" />
                    {t("სიის ექსპორტი (CSV)", "Export CSV")}
                  </Button>
                )}
              </div>
              {rows.items.length === 0 ? (
                <p className="mt-4">
                  {t(
                    "ამ ფილტრებით წევრები ვერ მოიძებნა.",
                    "No members match these filters.",
                  )}
                </p>
              ) : (
                <div className="overflow-x-auto mt-4">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr>
                        {[
                          t("წევრი", "Member"),
                          t("წევრობა და სტატუსი", "Membership and status"),
                          t(
                            "ქულები ხილულ ფარგლებში",
                            "Points in visible scope",
                          ),
                        ].map((x) => (
                          <th key={x} className="p-3">
                            {x}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.items.map((m) => (
                        <tr
                          key={m.id}
                          className="border-t border-[var(--border)]"
                        >
                          <td className="p-3">
                            <Button
                              variant="ghost"
                              onClick={() => {
                                setSelected(m.id);
                                setWorkPage(1);
                              }}
                            >
                              {name(m)}
                            </Button>
                          </td>
                          <td className="p-3">
                            <ul>
                              {m.memberships.map((x) => (
                                <li key={x.id}>
                                  {x.unitName} · {x.positionName} ·{" "}
                                  {label(x.status)}
                                </li>
                              ))}
                            </ul>
                          </td>
                          <td className="p-3">
                            {m.points ?? t("შეზღუდულია", "Restricted")}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {pagination(rows, setPage)}
            </Card>
          )}
          {selected && (
            <Button
              variant="ghost"
              onClick={() => {
                setSelected("");
                setDetail(null);
              }}
            >
              <ArrowLeft size={18} />
              {t("სიაში დაბრუნება", "Back to list")}
            </Button>
          )}
          {detail && (
            <>
              <Card>
                <div className="flex flex-wrap items-start gap-4">
                  {detail.verification?.portraitDataUrl && (() => {
                    const revealPortrait = revealedMemberId === detail.id;
                    return (
                      <div className="flex flex-col items-start gap-1.5">
                        <img
                          src={detail.verification.portraitDataUrl}
                          alt={name(detail)}
                          className={`h-20 w-20 rounded-xl border border-[var(--border)] object-cover transition ${revealPortrait ? "" : "blur-md"}`}
                        />
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() =>
                            setRevealedMemberId((id) =>
                              id === detail.id ? "" : detail.id,
                            )
                          }
                        >
                          {revealPortrait
                            ? t("ფოტოს დამალვა", "Hide photo")
                            : t("ფოტოს ჩვენება", "Show photo")}
                        </Button>
                      </div>
                    );
                  })()}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2
                        tabIndex={-1}
                        ref={heading}
                        className="text-xl font-semibold"
                      >
                        {name(detail)}
                      </h2>
                      {detail.verification?.assuranceLevel ===
                        "biometric_verified" && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-xs font-semibold text-emerald-600 dark:text-emerald-400">
                          {t(
                            "eID ბიომეტრიულად დადასტურებული",
                            "eID Biometrically Verified",
                          )}
                          {detail.verification.citizenshipCountry
                            ? ` · ${detail.verification.citizenshipCountry}`
                            : ""}
                        </span>
                      )}
                    </div>
                    <p className="break-all text-sm text-[var(--muted)]">
                      {t("წევრის კოდი", "Member code")}: {detail.id}
                    </p>
                    {detail.verification?.assuranceLevel ===
                      "biometric_verified" && (
                      <p className="mt-1 text-xs text-[var(--muted)]">
                        {typeof detail.verification.faceMatchScore ===
                          "number" && (
                          <>
                            {t("სახის თანხვედრა", "Face match")}:{" "}
                            <strong>
                              {Math.round(
                                detail.verification.faceMatchScore * 100,
                              )}
                              %
                            </strong>
                            {" · "}
                          </>
                        )}
                        {typeof detail.verification.livenessScore ===
                          "number" && (
                          <>
                            {t("სიცოცხლისუნარიანობა", "Liveness")}:{" "}
                            <strong>
                              {Math.round(
                                detail.verification.livenessScore * 100,
                              )}
                              %
                            </strong>
                            {" · "}
                          </>
                        )}
                        {detail.verification.sodCscaVerified
                          ? t("NFC SOD/CSCA: დადასტურებული", "NFC SOD/CSCA: verified")
                          : t("NFC SOD/CSCA: არ არის", "NFC SOD/CSCA: unverified")}
                        {detail.verification.verifiedAt
                          ? ` · ${new Date(detail.verification.verifiedAt).toLocaleDateString(
                              language === "ka" ? "ka-GE" : "en-GB",
                            )}`
                          : ""}
                      </p>
                    )}
                  </div>
                </div>
                <p className="mt-3">
                  {t("ქულები ხილულ ფარგლებში", "Points in visible scope")}:{" "}
                  {detail.points ?? t("შეზღუდულია", "Restricted")}
                </p>
                <p className="text-sm text-[var(--muted)]">
                  {t(
                    "სტატუსი ეხება წევრობას. ქულები არ განსაზღვრავს უფლებებს ან თანამდებობას.",
                    "Status describes membership. Points do not determine authority or position.",
                  )}
                </p>
                <div className="mt-4 space-y-3">
                  {detail.memberships.map((m) => (
                    <div
                      key={m.id}
                      className="border-t border-[var(--border)] pt-3"
                    >
                      <strong>
                        {m.unitName} · {m.positionName}
                      </strong>
                      <p>
                        {label(m.status)} · {date(m.validFrom)} —{" "}
                        {date(m.validUntil)}
                      </p>
                      {m.canChange && (
                        <MembershipChange
                          key={org + m.id}
                          organizationId={org}
                          membershipId={m.id}
                        />
                      )}
                    </div>
                  ))}
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  {detail.canPropose && (
                    <Button
                      variant="secondary"
                      onClick={() =>
                        navigate("/reviews", {
                          state: {
                            memberDirectory: {
                              organizationId: org,
                              memberId: detail.id,
                            },
                          },
                        })
                      }
                    >
                      {t("პოზიციის შეთავაზება", "Propose position")}
                    </Button>
                  )}
                  {detail.pointsScopes.map((u) => (
                    <Button
                      key={u.id}
                      variant="secondary"
                      onClick={() =>
                        navigate("/contribution", {
                          state: {
                            memberDirectory: {
                              organizationId: org,
                              memberId: detail.id,
                              unitId: u.id,
                            },
                          },
                        })
                      }
                    >
                      {t("ქულები და ჯილდო", "Points and recognition")} ·{" "}
                      {u.name}
                    </Button>
                  ))}
                </div>
              </Card>
              <Card>
                <h3 className="text-lg font-semibold">
                  {t("დავალებებში მონაწილეობა", "Task participation")}
                </h3>
                <p className="text-sm text-[var(--muted)]">
                  {t(
                    "მხოლოდ ამჟამად ნებადართული დავალებები; პროცენტი მონაწილის მიერ მითითებული პროგრესია.",
                    "Only currently permitted tasks; percentages are participant-reported progress.",
                  )}
                </p>
                <p>
                  {t("დადასტურებული", "Verified")}: {detail.work.verified}
                </p>
                {!detail.work.items.length && (
                  <p className="mt-3">
                    {t(
                      "ხილული მონაწილეობა არ არის.",
                      "No visible participation.",
                    )}
                  </p>
                )}
                <ul className="mt-3 space-y-3">
                  {detail.work.items.map((w) => (
                    <li
                      key={w.id}
                      className="flex flex-wrap gap-2 items-center border-t border-[var(--border)] pt-3"
                    >
                      <Button
                        variant="ghost"
                        onClick={() =>
                          navigate("/tasks", {
                            state: {
                              inbox: {
                                source: "work",
                                organizationId: org,
                                id: w.id,
                              },
                            },
                          })
                        }
                      >
                        {w.title}
                      </Button>
                      <span>
                        {label(w.status)} · {w.progress}%
                      </span>
                    </li>
                  ))}
                </ul>
                {pagination(detail.work, setWorkPage)}
              </Card>
            </>
          )}
        </>
      )}
    </div>
  );
}
