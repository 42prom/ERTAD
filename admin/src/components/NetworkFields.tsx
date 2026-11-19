import { useEffect, useRef, useState } from "react";
import { platformApi, type NetworkSettings } from "../api/platform";
import { useConsolePreferences } from "./useConsolePreferences";
import Input from "./ui/Input";
import Select from "./ui/Select";
import Button from "./ui/Button";

export function NetworkSummary({ settings }: { settings: NetworkSettings }) {
  const { language } = useConsolePreferences();
  const t = (ka: string, en: string) => (language === "ka" ? ka : en);
  const modes = {
    off: t("ქვეყნის ფილტრი გამორთულია", "Country filter off"),
    allow: t("მხოლოდ დაშვებული ქვეყნები", "Allowed countries only"),
    deny: t("აკრძალული ქვეყნები", "Blocked countries"),
  };
  return (
    <div className="space-y-2">
      <p>
        {modes[settings.mode]}
        {settings.countries.length ? ": " + settings.countries.join(", ") : ""}
      </p>
      {(["blocked", "exceptions"] as const).map((kind) => (
        <div key={kind}>
          <p>
            {kind === "blocked"
              ? t("დროებითი IP-ბლოკები", "Temporary IP blocks")
              : t("ქვეყნის წესის გამონაკლისები", "Country rule exceptions")}
            : {settings[kind].length}
          </p>
          <ul className="space-y-1">
            {settings[kind].map((row, index) => (
              <li key={row.key + index} className="break-all text-sm">
                <code title={row.key}>{row.key.slice(0, 16)}</code> ·{" "}
                {new Date(row.until).toLocaleString(
                  language === "ka" ? "ka-GE" : "en-GB",
                  { hour12: false },
                )}
                {Date.parse(row.until) <= Date.now()
                  ? t(" · ვადაგასულია", " · Expired")
                  : ""}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
export default function NetworkFields({
  value,
  onChange,
  disabled,
}: {
  value: NetworkSettings;
  onChange: (value: NetworkSettings) => void;
  disabled: boolean;
}) {
  const { language } = useConsolePreferences();
  const t = (ka: string, en: string) => (language === "ka" ? ka : en);
  const [address, setAddress] = useState(""),
    [kind, setKind] = useState<"blocked" | "exceptions">("blocked"),
    [hours, setHours] = useState("1"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const live = useRef(true),
    latest = useRef({ value, disabled });
  useEffect(() => { latest.current = { value, disabled }; }, [value, disabled]);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const add = async () => {
    if (disabled || busy || !address) return;
    setBusy(true);
    setError("");
    try {
      const result = await platformApi.networkAddressKey(address.trim());
      if (!live.current || latest.current.disabled) return;
      const current = latest.current.value;
      const rows = current[kind].filter((row) => row.key !== result.key);
      if (rows.length >= (kind === "blocked" ? 50 : 20))
        throw new Error("Limit");
      onChange({
        ...current,
        [kind]: [
          ...rows,
          {
            key: result.key,
            until: new Date(Date.now() + Number(hours) * 3600000).toISOString(),
          },
        ],
      });
      setAddress("");
    } catch {
      if (live.current)
        setError(
          t(
            "მისამართი ვერ დაემატა. შეამოწმეთ IPv4/IPv6, წვდომა და სიის ლიმიტი.",
            "Could not add address. Check IPv4/IPv6, access and list limit.",
          ),
        );
    } finally {
      if (live.current) setBusy(false);
    }
  };
  if (disabled) return <NetworkSummary settings={value} />;
  return (
    <fieldset className="space-y-4" disabled={busy}>
      <Select
        label={t("ქვეყნის ფილტრი", "Country filter")}
        value={value.mode}
        onChange={(e) =>
          onChange({
            ...value,
            mode: e.target.value as NetworkSettings["mode"],
          })
        }
        options={[
          { value: "off", label: t("გამორთული", "Off") },
          {
            value: "allow",
            label: t("მხოლოდ დაშვებული სია", "Allow list only"),
          },
          { value: "deny", label: t("აკრძალული სია", "Deny list") },
        ]}
      />
      <Input
        label={t("ქვეყნების კოდები (GE, DE)", "Country codes (GE, DE)")}
        value={value.countries.join(", ")}
        onChange={(e) =>
          onChange({
            ...value,
            countries:
              e.target.value === ""
                ? []
                : [
                    ...new Set(
                      e.target.value
                        .toUpperCase()
                        .split(",")
                        .map((v) => v.trim()),
                    ),
                  ],
          })
        }
      />
      <p className="text-sm">
        {t(
          "უცნობი ქვეყანა აქტიური ფილტრისას იბლოკება. IP-ბლოკი გამონაკლისზე უპირატესია. ვადა ითვლება სიაში დამატებიდან, მაქსიმუმ 24 საათი.",
          "Unknown countries are denied by an active filter. IP blocks override exceptions. Expiry starts when added, at most 24 hours.",
        )}
      </p>
      <Select
        label={t("IP-ქმედება", "IP action")}
        value={kind}
        onChange={(e) => setKind(e.target.value as typeof kind)}
        options={[
          { value: "blocked", label: t("დაბლოკვა", "Block") },
          {
            value: "exceptions",
            label: t("ქვეყნის წესის გამონაკლისი", "Country rule exception"),
          },
        ]}
      />
      <Input
        label={t("IP-მისამართი", "IP address")}
        autoComplete="off"
        value={address}
        maxLength={45}
        onChange={(e) => setAddress(e.target.value)}
      />
      <Select
        label={t("ვადა", "Duration")}
        value={hours}
        onChange={(e) => setHours(e.target.value)}
        options={["1", "4", "24"].map((value) => ({
          value,
          label: value + t(" საათი", " hours"),
        }))}
      />
      <Button
        type="button"
        variant="secondary"
        disabled={busy || !address}
        onClick={() => void add()}
      >
        {t("სიაში დამატება", "Add to list")}
      </Button>
      {error && <p role="alert">{error}</p>}
      <p className="text-sm">
        {t(
          "ინახება მისამართის დაცული ანაბეჭდი. საწყისი IP არ ინახება წესებსა და აუდიტში.",
          "Rules and audit store an address fingerprint, not the original IP.",
        )}
      </p>
      <NetworkSummary settings={value} />
      {(["blocked", "exceptions"] as const).map((type) =>
        value[type].map((row, index) => (
          <Button
            key={type + row.key + index}
            type="button"
            variant="secondary"
            onClick={() =>
              onChange({
                ...value,
                [type]: value[type].filter((_, i) => i !== index),
              })
            }
          >
            {t("ამოღება", "Remove")} ·{" "}
            {type === "blocked"
              ? t("ბლოკი", "Block")
              : t("გამონაკლისი", "Exception")}{" "}
            · {row.key.slice(0, 12)}
          </Button>
        )),
      )}
    </fieldset>
  );
}
