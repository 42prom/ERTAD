import { apiErrorMessage } from "../api/errors";
import { isAxiosError } from "axios";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { authApi } from "../api/client";
import DemoAccounts from "../components/DemoAccounts";
import { useConsolePreferences } from "../components/useConsolePreferences";
import {
  isWebAuthnSupported,
  startPasskeyAssertion,
} from "../utils/webauthnClient";
import type { AuthResponse } from "../types";

interface LoginProps {
  onLogin: () => void;
}

export default function Login({ onLogin }: LoginProps) {
  const { language } = useConsolePreferences();
  const ka = language === "ka";
  const t = (ge: string, en: string) => (ka ? ge : en);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [showMfaField, setShowMfaField] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const completeLogin = (response: AuthResponse) => {
    sessionStorage.setItem("admin_csrf", response.csrfToken);
    sessionStorage.setItem("admin_user", JSON.stringify(response.user));
    onLogin();
    navigate("/");
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading) return;
    setLoading(true);
    setError("");

    // Real authentication
    try {
      const code = totpCode.trim();
      const response = await authApi.login({
        email,
        password,
        ...(code ? { totpCode: code } : {}),
      });

      completeLogin(response);
    } catch (err: unknown) {
      const errCode = isAxiosError<{ error?: { code?: string } }>(err)
        ? err.response?.data?.error?.code
        : undefined;
      if (errCode === "MFA_ENROLLMENT_REQUIRED") {
        setError(
          t(
            "ამ ანგარიშზე შესვლამდე სავალდებულოა ორფაქტორიანი დაცვის (MFA/TOTP) ჩართვა. დაუკავშირდით ადმინისტრატორს.",
            "MFA enrollment is required for this account before sign-in. Contact your administrator.",
          ),
        );
      } else {
        setShowMfaField(true);
        setError(
          apiErrorMessage(
            err,
            t("ელფოსტა, პაროლი ან MFA კოდი არასწორია.", "Invalid credentials"),
          ),
        );
      }
    } finally {
      setLoading(false);
    }
  };

  const handlePasskeyLogin = async () => {
    if (loading) return;
    setLoading(true);
    setError("");
    try {
      const options = await authApi.passkeyLoginOptions();
      const assertion = await startPasskeyAssertion(options);
      const response = await authApi.passkeyLoginVerify({
        challengeId: options.challengeId,
        credentialId: assertion.credentialId,
        clientDataJSON: assertion.clientDataJSON,
        authenticatorData: assertion.authenticatorData,
        signature: assertion.signature,
      });
      completeLogin(response);
    } catch (err: unknown) {
      setError(
        apiErrorMessage(
          err,
          language === "ka"
            ? "გასაღებით შესვლა ვერ შესრულდა."
            : "Passkey sign-in failed.",
        ),
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="demo-login min-h-screen flex items-center justify-center bg-gray-900 p-4">
      <div className="max-w-md w-full space-y-8 p-8 bg-gray-800 rounded-lg shadow-lg">
        <div className="text-center">
          <img
            src="/ertad-logo-dark.png"
            alt="ERTAD"
            className="mx-auto h-20 w-auto object-contain mb-3"
          />
          <h2 className="text-center text-3xl font-bold text-white">ERTAD</h2>
          <p className="mt-2 text-center text-sm text-gray-400">
            {t("დაცული ადმინისტრაციული წვდომა", "Secure administrative access")}
          </p>
        </div>
        <DemoAccounts onLogin={completeLogin} disabled={loading} />
        <form className="mt-8 space-y-6" onSubmit={handleSubmit}>
          {error && (
            <div
              role="alert"
              className="bg-red-900/50 border border-red-500 text-red-200 px-4 py-3 rounded"
            >
              {error}
            </div>
          )}
          <div className="space-y-4">
            <div>
              <label
                htmlFor="email"
                className="block text-sm font-medium text-gray-300"
              >
                {t("ელფოსტა", "Email")}
              </label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="username"
                required
                className="mt-1 block w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                placeholder="admin@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div>
              <label
                htmlFor="password"
                className="block text-sm font-medium text-gray-300"
              >
                {t("პაროლი", "Password")}
              </label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                className="mt-1 block w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <div>
              <div className="flex items-center justify-between">
                <label
                  htmlFor="totpCode"
                  className="block text-sm font-medium text-gray-300"
                >
                  {t(
                    "ორფაქტორიანი (TOTP) ან აღდგენის კოდი",
                    "Authenticator (TOTP) or recovery code",
                  )}
                </label>
                {!showMfaField && (
                  <button
                    type="button"
                    onClick={() => setShowMfaField(true)}
                    className="text-xs text-primary-400 underline"
                  >
                    {t("მაქვს კოდი", "Have a code")}
                  </button>
                )}
              </div>
              {showMfaField && (
                <input
                  id="totpCode"
                  name="totpCode"
                  type="text"
                  autoComplete="one-time-code"
                  maxLength={16}
                  className="mt-1 block w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                  placeholder="123456 / XXXX-XXXX"
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value)}
                />
              )}
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500"
          >
            {loading
              ? t("შესვლა…", "Signing in…")
              : t("შესვლა", "Sign in")}
          </button>

          {isWebAuthnSupported() && (
            <button
              type="button"
              disabled={loading}
              onClick={() => void handlePasskeyLogin()}
              className="w-full flex justify-center py-2 px-4 border border-gray-600 rounded-md shadow-sm text-sm font-medium text-gray-200 bg-gray-700 hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500"
            >
              {language === "ka" ? "გასაღებით შესვლა (Passkey)" : "Sign in with Passkey"}
            </button>
          )}

          <div className="text-xs text-gray-400 text-center">
            <a href="/recover" className="underline inline-flex min-h-11 items-center">{language === 'ka' ? 'დაგავიწყდათ პაროლი?' : 'Forgot password?'}</a>
          </div>
          <div className="text-xs text-gray-400 text-center">
            {t(
              "მონაცემების მისაღებად დაუკავშირდით ადმინისტრატორს",
              "Contact your administrator for credentials",
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
