import { useCallback, useState } from "react";
import { Bell } from "lucide-react";
import { accountApi, type OwnNotificationsView } from "../api/account";
import { useAsyncResource } from "./useAsyncResource";
import { useConsolePreferences } from "./useConsolePreferences";
import Card from "./ui/Card";
import Button from "./ui/Button";

export default function OwnNotifications() {
  const { language } = useConsolePreferences();
  const t = (ka: string, en: string) => (language === "ka" ? ka : en);
  const [revision, setRevision] = useState(0);
  const load = useCallback(() => accountApi.notifications(), []);
  const res = useAsyncResource<OwnNotificationsView>(String(revision), load);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  async function toggle(
    field: "eventReminders" | "taskDeadlines" | "approvalDigests" | "channelMentions",
    value: boolean,
  ) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await accountApi.updateNotifications({ [field]: value });
      setNotice(
        t(
          "შეტყობინებების პარამეტრები შენახულია.",
          "Notification preferences saved.",
        ),
      );
      setRevision((v) => v + 1);
    } catch {
      setError(
        t(
          "პარამეტრების შენახვა ვერ შესრულდა.",
          "Could not save notification preferences.",
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  async function syncQueue() {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const updated = await accountApi.syncNotifications();
      setNotice(
        t(
          `შემოწმდა მოახლოებული ვადები (დაემატა: ${updated.newlyQueued}).`,
          `Synced upcoming deadlines (${updated.newlyQueued} queued).`,
        ),
      );
      setRevision((v) => v + 1);
    } catch {
      setError(
        t(
          "რიგის სინქრონიზაცია ვერ შესრულდა.",
          "Could not synchronize notification outbox.",
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <h2 className="text-lg font-semibold flex items-center gap-2">
        <Bell size={18} aria-hidden="true" />
        {t("დომენური შეტყობინებები (Opt-in)", "Opt-in email reminders")}
      </h2>
      <p className="text-sm mt-1">
        {t(
          "ყველა დომენური ელფოსტის შეტყობინება ნაგულისხმევად გამორთულია. შეტყობინებები არ შეიცავს პირად მონაცემებს ან წერილების ტექსტს.",
          "All domain email reminders are off by default. Dispatches contain zero personal data or message bodies.",
        )}
      </p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {res.data && (
        <div className="space-y-3 mt-3">
          {(
            [
              [
                "eventReminders",
                t("ღონისძიების შეხსენება (48 საათით ადრე)", "Event reminder (48h before start)"),
              ],
              [
                "taskDeadlines",
                t("დავალების ვადის გაფრთხილება (24 საათით ადრე)", "Task deadline alert (24h before deadline)"),
              ],
              [
                "approvalDigests",
                t("მოლოდინში მყოფი დამტკიცებების შეჯამება", "Pending approval queue digest"),
              ],
              [
                "channelMentions",
                t("არხში ხსენების (@mention) გაფრთხილება", "Channel @mention alert"),
              ],
            ] as const
          ).map(([field, label]) => (
            <label key={field} className="review-confirm">
              <input
                type="checkbox"
                checked={res.data!.preferences[field]}
                disabled={busy}
                onChange={(e) => void toggle(field, e.target.checked)}
              />
              {label}
            </label>
          ))}
          <div className="pt-2">
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={() => void syncQueue()}
            >
              {t("მოახლოებული შეხსენებების შემოწმება", "Sync queued reminders")}
            </Button>
          </div>
          {res.data.recentQueued.length > 0 && (
            <ul className="border-t pt-3 space-y-1 text-sm">
              {res.data.recentQueued.map((item) => (
                <li key={item.id} className="flex justify-between gap-2">
                  <span>{item.title}</span>
                  <span>
                    {new Date(item.scheduledFor).toLocaleString(
                      language === "ka" ? "ka-GE" : "en-GB",
                      { hour12: false },
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}

