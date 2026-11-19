import { useId, useState } from "react";
import { Link } from "react-router-dom";
import Select from "./ui/Select";
import { useConsolePreferences } from "./useConsolePreferences";

export interface RewardChoice {
  id: string;
  title?: string;
  amount: number;
  memberMonthCap: number;
}
/** Key by the creation scope: changing unit must discard the previous offer. */
export default function ParticipationReward({
  value,
  onChange,
  options,
  label,
}: {
  value: string | null;
  onChange: (value: string | null) => void;
  options: RewardChoice[];
  label: string;
}) {
  const { language } = useConsolePreferences(),
    t = (ka: string, en: string) => (language === "ka" ? ka : en);
  const name = useId(),
    [enabled, setEnabled] = useState(!!value);
  return (
    <fieldset className="space-y-3 rounded-lg border border-gray-300 p-4 min-w-0">
      <legend className="px-2 font-semibold">
        {t("ქულების მინიჭება", "Award points")}
      </legend>
      <div className="flex flex-wrap gap-x-6 gap-y-3">
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name={name}
            value="yes"
            checked={enabled}
            onChange={() => setEnabled(true)}
          />
          {t("მიენიჭოს ქულები", "Assign points")}
        </label>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name={name}
            value="no"
            checked={!enabled}
            onChange={() => {
              setEnabled(false);
              onChange(null);
            }}
          />
          {t("ქულები არ მიენიჭოს", "Do not assign points")}
        </label>
      </div>
      {enabled && (
        <>
          <Select
            label={label}
            value={value ?? ""}
            required
            onChange={(e) => onChange(e.target.value || null)}
            options={[
              {
                value: "",
                label: t("აირჩიეთ ქულების წესი", "Choose a points rule"),
              },
              ...options.map((r) => ({
                value: r.id,
                label: `${r.title || t("ორგანიზაციის საერთო წესი", "Organization default")} · ${r.amount} ${t("ქულა", "points")} · ${t("თვის ზღვარი", "monthly cap")} ${r.memberMonthCap}`,
              })),
            ]}
          />
          {!options.length && (
            <p role="status">
              {t(
                "ამ ერთეულისთვის მოქმედი წესი ჯერ არ არის. ქულების მისანიჭებლად საჭიროა დამტკიცებული წესი.",
                "No active rule is available for this unit. Assigning points requires an approved rule.",
              )}{" "}
              <Link className="text-primary-600 underline" to="/contribution">
                {t("ჯილდოების წესები", "Recognition rules")}
              </Link>
            </p>
          )}
        </>
      )}
    </fieldset>
  );
}
