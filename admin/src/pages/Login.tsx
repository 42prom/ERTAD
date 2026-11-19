import { apiErrorMessage } from "../api/errors";
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
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
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
      const response = await authApi.login({ email, password });

      completeLogin(response);
    } catch (err: unknown) {
      setError(apiErrorMessage(err, "Invalid credentials"));
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
            Secure administrative access
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
                Email
              </label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="username"
                required
                className="mt-1 block w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-facebook-blue focus:border-transparent"
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
                Password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                className="mt-1 block w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-facebook-blue focus:border-transparent"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-facebook-blue hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-facebook-blue"
          >
            {loading ? "Signing in…" : "Sign in"}
          </button>

          {isWebAuthnSupported() && (
            <button
              type="button"
              disabled={loading}
              onClick={() => void handlePasskeyLogin()}
              className="w-full flex justify-center py-2 px-4 border border-gray-600 rounded-md shadow-sm text-sm font-medium text-gray-200 bg-gray-700 hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-facebook-blue"
            >
              {language === "ka" ? "გასაღებით შესვლა (Passkey)" : "Sign in with Passkey"}
            </button>
          )}

          <div className="text-xs text-gray-400 text-center">
            <a href="/recover" className="underline inline-flex min-h-11 items-center">{language === 'ka' ? 'დაგავიწყდათ პაროლი?' : 'Forgot password?'}</a>
          </div>
          <div className="text-xs text-gray-400 text-center">
            Contact your administrator for credentials
          </div>
        </form>
      </div>
    </div>
  );
}
