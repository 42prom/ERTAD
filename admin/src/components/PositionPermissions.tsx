import type { PositionGrant } from "../api/positions";
import { useConsolePreferences } from "./useConsolePreferences";

import { positionPermissionLabel } from "./positionPermissionNames";
export default function PositionPermissions({
  grants,
}: {
  grants: PositionGrant[];
}) {
  const { language } = useConsolePreferences();
  return (
    <ul className="space-y-2 break-words">
      {grants.map((g) => (
        <li key={g.permission + g.scope}>
          {positionPermissionLabel(g.permission, language)} —{" "}
          {g.scope === "subtree"
            ? language === "ka"
              ? "ერთეული და ქვემდგომები"
              : "Unit and descendants"
            : language === "ka"
              ? "მხოლოდ ეს ერთეული"
              : "This unit only"}
        </li>
      ))}
    </ul>
  );
}
