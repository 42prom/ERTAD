import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import RecoverAccount from "../pages/RecoverAccount";
import { recoveryApi } from "../api/recovery";
vi.mock("../components/useConsolePreferences", () => ({
  useConsolePreferences: () => ({ language: "en" }),
}));
vi.mock("../api/recovery", () => ({
  recoveryApi: { request: vi.fn(), complete: vi.fn() },
}));
beforeEach(() => {
  vi.resetAllMocks();
  window.history.replaceState(null, "", "/recover");
});
it("accepts a recovery link opened in the existing request tab without reloading or retaining the old token", async () => {
  render(<RecoverAccount />);
  window.history.replaceState(null, "", `/recover#${id}.${token}`);
  fireEvent(window, new HashChangeEvent("hashchange"));
  expect(
    await screen.findByRole("heading", { name: "Set a new password" }),
  ).toBeVisible();
  expect(window.location.hash).toBe("");
  fill();
  window.history.replaceState(null, "", "/recover#broken");
  fireEvent(window, new HashChangeEvent("hashchange"));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "complete, valid recovery link",
  );
  expect(screen.queryByLabelText("Repeat password")).toBeNull();
  expect(recoveryApi.complete).not.toHaveBeenCalled();
});
const token = "a".repeat(43),
  id = "11111111-1111-4111-8111-111111111111";
function openLink() {
  window.history.replaceState(null, "", `/recover#${id}.${token}`);
  render(<RecoverAccount />);
}
function fill() {
  fireEvent.change(screen.getByLabelText("Password", { exact: true }), {
    target: { value: "Synthetic-recovery-password-39!" },
  });
  fireEvent.change(screen.getByLabelText("Repeat password"), {
    target: { value: "Synthetic-recovery-password-39!" },
  });
}
it("requests recovery only on explicit submit and clears the contact after a generic acknowledgement", async () => {
  vi.mocked(recoveryApi.request).mockResolvedValue({ accepted: true });
  render(<RecoverAccount />);
  expect(recoveryApi.request).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Email"), {
    target: { value: "synthetic@example.invalid" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Request recovery link" }),
  );
  await screen.findByRole("status");
  expect(recoveryApi.request).toHaveBeenCalledExactlyOnceWith(
    "synthetic@example.invalid",
  );
  expect(screen.queryByLabelText("Email")).toBeNull();
  expect(screen.getByRole("status").textContent).toContain(
    "If recovery is available",
  );
});
it("keeps an uncertain request explicit and does not retry automatically", async () => {
  vi.mocked(recoveryApi.request).mockRejectedValue(new Error("offline"));
  render(<RecoverAccount />);
  fireEvent.change(screen.getByLabelText("Email"), {
    target: { value: "synthetic@example.invalid" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Request recovery link" }),
  );
  await screen.findByRole("alert");
  expect(recoveryApi.request).toHaveBeenCalledTimes(1);
});
it("removes the fragment without consumption and requires matching passwords plus explicit session-revocation consent", async () => {
  vi.mocked(recoveryApi.complete).mockResolvedValue({ recovered: true });
  openLink();
  expect(window.location.hash).toBe("");
  expect(recoveryApi.complete).not.toHaveBeenCalled();
  fill();
  expect(screen.getByRole("button", { name: "Reset password" })).toBeDisabled();
  fireEvent.click(
    screen.getByLabelText(
      "I confirm changing the password and closing old sessions",
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Reset password" }));
  await screen.findByRole("status");
  expect(recoveryApi.complete).toHaveBeenCalledExactlyOnceWith(
    id,
    token,
    "Synthetic-recovery-password-39!",
  );
  expect(screen.queryByLabelText("Repeat password")).toBeNull();
  expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute(
    "href",
    "/login",
  );
});
it("clears secrets on uncertain consumption and offers normal login instead of replay", async () => {
  vi.mocked(recoveryApi.complete).mockRejectedValue({
    response: { status: 503 },
  });
  openLink();
  fill();
  fireEvent.click(
    screen.getByLabelText(
      "I confirm changing the password and closing old sessions",
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Reset password" }));
  await screen.findByRole("alert");
  expect(screen.queryByRole("button", { name: "Reset password" })).toBeNull();
  expect(recoveryApi.complete).toHaveBeenCalledTimes(1);
});
it("rejects incomplete links and clears password confirmation after a known expiry error", async () => {
  window.history.replaceState(null, "", "/recover#broken");
  const view = render(<RecoverAccount />);
  expect(screen.getByRole("alert")).toHaveTextContent(
    "complete, valid recovery link",
  );
  expect(recoveryApi.complete).not.toHaveBeenCalled();
  view.unmount();
  vi.mocked(recoveryApi.complete).mockRejectedValue({
    response: { status: 409 },
  });
  openLink();
  fill();
  fireEvent.click(
    screen.getByLabelText(
      "I confirm changing the password and closing old sessions",
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Reset password" }));
  await screen.findByRole("alert");
  await waitFor(() =>
    expect(screen.getByLabelText("Password", { exact: true })).toHaveValue(""),
  );
  expect(
    screen.getByLabelText(
      "I confirm changing the password and closing old sessions",
    ),
  ).not.toBeChecked();
});
