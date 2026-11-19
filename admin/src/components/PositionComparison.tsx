import type { RevisionComparison } from "../api/reviews";
import PositionPermissions from "./PositionPermissions";
import { useConsolePreferences } from "./useConsolePreferences";

export default function PositionComparison({
  comparison,
}: {
  comparison: RevisionComparison;
}) {
  const { language } = useConsolePreferences();
  const ka = language === "ka";
  return (
    <section aria-label={ka ? "უფლებების შედარება" : "Permission comparison"}>
      <p className="font-semibold break-words">
        {comparison.sourceName} → {comparison.destinationName}
      </p>
      <div className="grid gap-4 md:grid-cols-3 mt-3">
        {(
          [
            ["added", ka ? "ემატება" : "Added"],
            ["removed", ka ? "უქმდება" : "Removed"],
            ["unchanged", ka ? "უცვლელი" : "Unchanged"],
          ] as const
        ).map(([key, label]) => (
          <div key={key}>
            <h3 className="font-semibold mb-2">{label}</h3>
            {comparison[key].length ? (
              <PositionPermissions grants={comparison[key]} />
            ) : (
              <p>{ka ? "არ არის" : "None"}</p>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
