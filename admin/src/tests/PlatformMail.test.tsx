import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import PlatformMail from "../components/PlatformMail";
import { mailPolicyApi, type MailPolicyList } from "../api/mailPolicy";
import { authApi } from "../api/client";
vi.mock("../components/useConsolePreferences", () => ({
  useConsolePreferences: () => ({ language: "en" }),
}));
vi.mock("../api/mailPolicy", () => ({
  mailPolicyApi: {
    list: vi.fn(),
    propose: vi.fn(),
    review: vi.fn(),
    check: vi.fn(),
  },
}));
vi.mock("../api/client", () => ({ authApi: { stepUp: vi.fn() } }));
const data: MailPolicyList = {
  current: {
    version: 0,
    provider: "none",
    mode: "off",
    senderName: "",
    senderEmail: "",
    hasCredential: false,
  },
  items: [],
  nextBefore: null,
};
beforeEach(() => {
  vi.resetAllMocks();
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  vi.mocked(mailPolicyApi.list).mockResolvedValue(structuredClone(data));
  vi.mocked(authApi.stepUp).mockResolvedValue({
    expiresAt: "2026-11-09T00:00:00Z",
  });
});
async function configure() {
  fireEvent.click(
    await screen.findByRole("button", { name: "Change email settings" }),
  );
  fireEvent.change(screen.getByLabelText("Provider"), {
    target: { value: "sendgrid" },
  });
  fireEvent.change(screen.getByLabelText(/New API key/), {
    target: { value: "SG.synthetic-key" },
  });
  fireEvent.change(screen.getByLabelText("Sender name"), {
    target: { value: "ERTAD" },
  });
  fireEvent.change(screen.getByLabelText("Sender email"), {
    target: { value: "sender@example.invalid" },
  });
  fireEvent.change(screen.getByLabelText("Mode"), {
    target: { value: "enabled" },
  });
  fireEvent.change(screen.getByLabelText("Your password"), {
    target: { value: "synthetic-password" },
  });
}
it("submits explicit sender configuration only after real password confirmation and clears secrets", async () => {
  render(<PlatformMail canPropose canApprove={false} canTest />);
  await configure();
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  await screen.findByText("Change submitted for independent approval.");
  expect(authApi.stepUp).toHaveBeenCalledWith("synthetic-password");
  expect(mailPolicyApi.propose).toHaveBeenCalledWith({
    requestId: expect.any(String),
    expectedVersion: 0,
    provider: "sendgrid",
    mode: "enabled",
    senderName: "ERTAD",
    senderEmail: "sender@example.invalid",
    apiKey: "SG.synthetic-key",
    reason: "provider_change",
    deliveryEnabled:false,publicOrigin:'',smtpService:'sendgrid',smtpUser:'',
  });
  expect(screen.queryByLabelText(/New API key/)).toBeNull();
  expect(screen.queryByLabelText("Your password")).toBeNull();
});
it("failed password confirmation prevents mutation and clears secrets", async () => {
  vi.mocked(authApi.stepUp).mockRejectedValue(Error("denied"));
  render(<PlatformMail canPropose canApprove={false} canTest />);
  await configure();
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  await screen.findByText("Password confirmation failed.");
  expect(mailPolicyApi.propose).not.toHaveBeenCalled();
  expect(screen.queryByLabelText("Your password")).toBeNull();
});
it("unknown save outcome refreshes without automatic retry", async () => {
  vi.mocked(mailPolicyApi.propose).mockRejectedValue(Error("offline"));
  render(<PlatformMail canPropose canApprove={false} canTest />);
  await configure();
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  await screen.findByText(/outcome could not be confirmed/);
  expect(mailPolicyApi.propose).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(mailPolicyApi.list).toHaveBeenCalledTimes(2));
  expect(screen.queryByLabelText(/New API key/)).toBeNull();
});
it("read-only access exposes neither configuration nor diagnostics and denied reload removes data", async () => {
  const view = render(
    <PlatformMail canPropose={false} canApprove={false} canTest={false} />,
  );
  await screen.findByText("Not stored");
  expect(
    screen.queryByRole("button", { name: "Change email settings" }),
  ).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Validate without sending" }),
  ).toBeNull();
  vi.mocked(mailPolicyApi.list).mockRejectedValue(Error("denied"));
  view.rerender(
    <PlatformMail
      canPropose={false}
      canApprove={false}
      canTest={false}
      refreshRevision={1}
    />,
  );
  await screen.findByRole("alert");
  expect(screen.queryByText("Not stored")).toBeNull();
});
it("sandbox result states its limit and disappears after parent refresh", async () => {
  vi.mocked(mailPolicyApi.check).mockResolvedValue({
    version: 0,
    status: "valid",
  });
  const view = render(<PlatformMail canPropose canApprove={false} canTest />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Validate without sending" }),
  );
  fireEvent.change(screen.getByLabelText("Your password"), {
    target: { value: "synthetic-password" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  await screen.findByText(/Provider validation passed/);
  expect(mailPolicyApi.check).toHaveBeenCalledWith(0);
  view.rerender(
    <PlatformMail canPropose canApprove={false} canTest refreshRevision={1} />,
  );
  await waitFor(() => expect(mailPolicyApi.list).toHaveBeenCalledTimes(3));
  expect(screen.queryByText(/Provider validation passed/)).toBeNull();
});
