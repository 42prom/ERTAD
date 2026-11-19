import { useCallback, useState, type FormEvent } from "react";
import { KeyRound, ShieldCheck, Fingerprint, Trash2 } from "lucide-react";
import {
  accountApi,
  type OwnPasskey,
  type OwnTotpStatus,
} from "../api/account";
import { apiErrorStatus } from "../api/errors";
import {
  isWebAuthnSupported,
  startPasskeyRegistration,
} from "../utils/webauthnClient";
import { encodeQrMatrix, qrSvgPath } from "../utils/qrCode";
import { useAsyncResource } from "./useAsyncResource";
import { useConsolePreferences } from "./useConsolePreferences";
import Card from "./ui/Card";
import Button from "./ui/Button";
import Input from "./ui/Input";

export default function OwnMfaAndPasskeys() {
  const { language } = useConsolePreferences();
  const t = (ka: string, en: string) => (language === "ka" ? ka : en);
  const [revision, setRevision] = useState(0);
  const loadTotp = useCallback(() => accountApi.totpStatus(), []);
  const loadPasskeys = useCallback(() => accountApi.passkeys(), []);
  const totpRes = useAsyncResource<OwnTotpStatus>(String(revision), loadTotp);
  const passkeysRes = useAsyncResource<{ items: OwnPasskey[] }>(
    String(revision),
    loadPasskeys,
  );

  const [setupData, setSetupData] = useState<{
    secret: string;
    otpauthUri: string;
  } | null>(null);
  const [totpCode, setTotpCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [passkeyLabel, setPasskeyLabel] = useState("Hardware / Device Passkey");
  const [renameId, setRenameId] = useState("");
  const [renameLabel, setRenameLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function beginTotp() {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const started = await accountApi.totpSetup();
      setSetupData({ secret: started.secret, otpauthUri: started.otpauthUri });
      setTotpCode("");
      setRevision((v) => v + 1);
    } catch (e) {
      setError(
        apiErrorStatus(e) === 428
          ? t("საჭიროა პაროლით დადასტურება.", "Password confirmation required.")
          : t("TOTP დაყენება ვერ დაიწყო.", "Could not start TOTP setup."),
      );
    } finally {
      setBusy(false);
    }
  }

  async function confirmTotp(e: FormEvent) {
    e.preventDefault();
    if (busy || !/^\d{6}$/.test(totpCode.trim())) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const done = await accountApi.totpConfirm(totpCode.trim());
      setRecoveryCodes(done.recoveryCodes);
      setSetupData(null);
      setTotpCode("");
      setNotice(
        t(
          "ორფაქტორიანი აუთენტიფიკაცია (TOTP) გააქტიურდა. შეინახეთ აღდგენის კოდები.",
          "Two-factor TOTP authenticator enabled. Save your recovery codes now.",
        ),
      );
      setRevision((v) => v + 1);
    } catch {
      setError(
        t(
          "6-ნიშნა კოდი არასწორია ან ვადაგასულია.",
          "Invalid or expired 6-digit code.",
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  async function regenerateCodes() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await accountApi.totpRegenerateRecovery();
      setRecoveryCodes(res.recoveryCodes);
      setNotice(
        t(
          "აღდგენის კოდები განახლდა. წინა კოდები გაუქმდა.",
          "Recovery codes rotated. Previous codes are invalidated.",
        ),
      );
      setRevision((v) => v + 1);
    } catch {
      setError(
        t(
          "კოდების განახლება ვერ შესრულდა.",
          "Could not regenerate recovery codes.",
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  async function disableTotp() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await accountApi.totpDisable();
      setSetupData(null);
      setRecoveryCodes(null);
      setNotice(
        t(
          "მომხმარებლის TOTP ჩანაწერი განულდა. ხელახალი დაყენება ნებისმიერ დროს შეგიძლიათ.",
          "User TOTP setup reset. You can re-enroll anytime.",
        ),
      );
      setRevision((v) => v + 1);
    } catch {
      setError(t("TOTP განულება ვერ შესრულდა.", "Could not reset TOTP setup."));
    } finally {
      setBusy(false);
    }
  }

  async function addPasskey(e: FormEvent) {
    e.preventDefault();
    if (busy || !passkeyLabel.trim()) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const options = await accountApi.passkeyRegisterOptions(
        passkeyLabel.trim(),
      );
      const cred = await startPasskeyRegistration(options);
      await accountApi.passkeyRegisterVerify({
        challengeId: options.challengeId,
        label: passkeyLabel.trim(),
        clientDataJSON: cred.clientDataJSON,
        attestationObject: cred.attestationObject,
        transports: cred.transports,
      });
      setNotice(
        t("აპარატურული გასაღები დამატებულია.", "Hardware passkey registered."),
      );
      setRevision((v) => v + 1);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      setError(
        msg === "WEBAUTHN_UNSUPPORTED"
          ? t(
              "ამ ბრაუზერში WebAuthn არ არის მხარდაჭერილი.",
              "WebAuthn passkeys are not supported in this browser.",
            )
          : msg === "WEBAUTHN_CANCELLED"
            ? t("გასაღების დამატება გაუქმდა.", "Passkey registration cancelled.")
            : t(
                "გასაღების დამატება ვერ შესრულდა.",
                "Could not register passkey.",
              ),
      );
    } finally {
      setBusy(false);
    }
  }

  async function saveRename(passkeyId: string) {
    if (busy || !renameLabel.trim()) return;
    setBusy(true);
    setError("");
    try {
      await accountApi.passkeyRename(passkeyId, renameLabel.trim());
      setRenameId("");
      setRenameLabel("");
      setRevision((v) => v + 1);
    } catch {
      setError(t("სახელის შეცვლა ვერ შესრულდა.", "Could not rename passkey."));
    } finally {
      setBusy(false);
    }
  }

  async function removePasskey(passkeyId: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await accountApi.passkeyDelete(passkeyId);
      setNotice(t("გასაღები წაშლილია.", "Passkey removed."));
      setRevision((v) => v + 1);
    } catch {
      setError(t("გასაღების წაშლა ვერ შესრულდა.", "Could not remove passkey."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}

      {recoveryCodes && (
        <Card className="decision-receipt-card">
          <div className="review-toolbar">
            <div>
              <strong>
                {t("ერთჯერადი აღდგენის კოდები", "Single-use recovery codes")}
              </strong>
              <p className="text-sm mt-1">
                {t(
                  "შეინახეთ ეს 8 კოდი უსაფრთხო ადგილას. დახურვის შემდეგ სრულად აღარ გამოჩნდება.",
                  "Save these 8 codes securely. Once dismissed, they will not be shown again.",
                )}
              </p>
              <div className="decision-receipt-list">
                {recoveryCodes.map((code) => (
                  <code key={code}>{code}</code>
                ))}
              </div>
            </div>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setRecoveryCodes(null)}
            >
              {t("დახურვა", "Dismiss")}
            </Button>
          </div>
        </Card>
      )}

      <Card>
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <ShieldCheck size={18} aria-hidden="true" />
          {t("ორფაქტორიანი აუთენტიფიკაცია (TOTP)", "Two-factor authenticator (TOTP)")}
        </h2>
        {totpRes.data && (
          <div className="space-y-3 mt-3">
            <p>
              {totpRes.data.enabled
                ? t(
                    `დაყენებულია და დადასტურებულია · დარჩენილი აღდგენის კოდები: ${totpRes.data.recoveryRemaining}`,
                    `Enrolled and verified · Remaining recovery codes: ${totpRes.data.recoveryRemaining}`,
                  )
                : t(
                    "პირადი აპლიკაციის კოდი ჯერ არ არის დადასტურებული.",
                    "Authenticator app code is not yet verified by you.",
                  )}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={() => void beginTotp()}
              >
                <KeyRound size={16} aria-hidden="true" />
                {totpRes.data.enabled
                  ? t("ახალი საიდუმლოს გენერაცია", "Rotate TOTP secret")
                  : t("TOTP აპლიკაციის დაყენება", "Set up TOTP app")}
              </Button>
              {totpRes.data.enabled && (
                <>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => void regenerateCodes()}
                  >
                    {t("აღდგენის კოდების განახლება", "Regenerate recovery codes")}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => void disableTotp()}
                  >
                    {t("დაყენების განულება", "Reset TOTP setup")}
                  </Button>
                </>
              )}
            </div>
            {setupData && (() => {
              const qr = qrSvgPath(encodeQrMatrix(setupData.otpauthUri), 4);
              return (
                <form onSubmit={confirmTotp} className="space-y-3 mt-3 border-t pt-3">
                  <p className="text-sm">
                    {t(
                      "დაასკანერეთ QR კოდი ან ჩაწერეთ საიდუმლო კოდი თქვენს აპლიკაციაში (Google Authenticator / Bitwarden / 1Password):",
                      "Scan the QR code or enter this secret in your authenticator app:",
                    )}
                  </p>
                  <div className="inline-block p-3 bg-white rounded-lg border">
                    <svg
                      role="img"
                      aria-label={t("TOTP QR კოდი", "TOTP QR code")}
                      viewBox={`0 0 ${qr.size} ${qr.size}`}
                      width={192}
                      height={192}
                      shapeRendering="crispEdges"
                    >
                      <rect width={qr.size} height={qr.size} fill="#ffffff" />
                      <path d={qr.path} fill="#000000" />
                    </svg>
                  </div>
                  <div>
                    <span className="text-xs font-medium block">Base32 Secret</span>
                    <code className="decision-receipt-code break-all">
                      {setupData.secret}
                    </code>
                  </div>
                  <div>
                    <span className="text-xs font-medium block">Provisioning URI</span>
                    <code className="text-xs break-all block">
                      {setupData.otpauthUri}
                    </code>
                  </div>
                  <Input
                    label={t("6-ნიშნა TOTP კოდი დასადასტურებლად", "6-digit confirmation code")}
                    value={totpCode}
                    required
                    pattern="\d{6}"
                    maxLength={6}
                    onChange={(e) => setTotpCode(e.target.value)}
                  />
                  <Button type="submit" disabled={busy}>
                    {t("კოდის დადასტურება და გააქტიურება", "Verify & activate TOTP")}
                  </Button>
                </form>
              );
            })()}
          </div>
        )}
      </Card>

      <Card>
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Fingerprint size={18} aria-hidden="true" />
          {t("აპარატურული გასაღებები (WebAuthn / Passkeys)", "Passkeys (FIDO2 / WebAuthn)")}
        </h2>
        <p className="text-sm mt-1">
          {t(
            "გამოიყენეთ Face ID, Touch ID, Windows Hello ან აპარატურული YubiKey პაროლის გარეშე შესასვლელად და მოქმედებების დასადასტურებლად.",
            "Use Face ID, Touch ID, Windows Hello or a FIDO2 security key for phishing-resistant sign-in and step-up confirmation.",
          )}
        </p>
        <form onSubmit={addPasskey} className="flex flex-wrap gap-3 items-end mt-3">
          <Input
            label={t("გასაღების სახელი", "Passkey label")}
            value={passkeyLabel}
            required
            maxLength={80}
            onChange={(e) => setPasskeyLabel(e.target.value)}
          />
          <Button
            type="submit"
            disabled={busy || !isWebAuthnSupported()}
          >
            {t("ახალი გასაღების დამატება", "Register passkey")}
          </Button>
        </form>
        {!isWebAuthnSupported() && (
          <p className="text-sm mt-2">
            {t(
              "WebAuthn მხარდაჭერილია თანამედროვე HTTPS/localhost ბრაუზერებში.",
              "WebAuthn is available in modern browsers over HTTPS or localhost.",
            )}
          </p>
        )}
        {passkeysRes.data && (
          <ul className="mt-4 space-y-2">
            {!passkeysRes.data.items.length ? (
              <li>
                {t("გასაღებები ჯერ არ არის დამატებული.", "No passkeys registered yet.")}
              </li>
            ) : (
              passkeysRes.data.items.map((pk) => (
                <li
                  key={pk.id}
                  className="flex flex-wrap items-center justify-between gap-2 border-t pt-2"
                >
                  <div>
                    {renameId === pk.id ? (
                      <div className="flex gap-2 items-center">
                        <Input
                          label={t("ახალი სახელი", "New label")}
                          value={renameLabel}
                          onChange={(e) => setRenameLabel(e.target.value)}
                        />
                        <Button
                          type="button"
                          variant="secondary"
                          onClick={() => void saveRename(pk.id)}
                        >
                          {t("შენახვა", "Save")}
                        </Button>
                      </div>
                    ) : (
                      <>
                        <strong>{pk.label}</strong>
                        <p className="text-xs">
                          {pk.algorithm === -7 ? "ES256" : "RS256"} ·{" "}
                          {new Date(pk.createdAt).toLocaleDateString(
                            language === "ka" ? "ka-GE" : "en-GB",
                          )}
                        </p>
                      </>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => {
                        setRenameId(pk.id);
                        setRenameLabel(pk.label);
                      }}
                    >
                      {t("გადარქმევა", "Rename")}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={busy}
                      aria-label={`${t("წაშლა", "Remove")} ${pk.label}`}
                      onClick={() => void removePasskey(pk.id)}
                    >
                      <Trash2 size={16} />
                    </Button>
                  </div>
                </li>
              ))
            )}
          </ul>
        )}
      </Card>
    </div>
  );
}

