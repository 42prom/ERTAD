import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import DemoAccounts from "../components/DemoAccounts";
import { demoApi } from "../api/demo";
vi.mock("../components/useConsolePreferences", () => ({
  useConsolePreferences: () => ({ language: "en" }),
}));
vi.mock("../api/demo", () => ({
  demoApi: { accounts: vi.fn(), login: vi.fn() },
}));
beforeEach(() => vi.resetAllMocks());
it("renders the optional technical account beside organization accounts and submits only its ID", async () => {
  const accounts = [
    ...Array.from({ length: 6 }, (_, i) => ({
      id: `org-${i}`,
      email: `org${i}@demo.ertad.local`,
      label: `Organization ${i}`,
      region: "Synthetic",
    })),
    {
      id: "technical",
      email: "platform@ertad.local",
      label: "Technical",
      region: "System",
      kind: "technical" as const,
    },
  ];
  vi.mocked(demoApi.accounts).mockResolvedValue({ enabled: true, accounts });
  vi.mocked(demoApi.login).mockRejectedValue(new Error("Unavailable"));
  render(<DemoAccounts onLogin={vi.fn()} disabled={false} />);
  fireEvent.click(
    await screen.findByRole("button", {
      name: /Technical administrator.*platform@ertad.local/,
    }),
  );
  expect(screen.getAllByRole("button")).toHaveLength(7);
  expect(demoApi.login).toHaveBeenCalledWith("technical");
  await screen.findByRole("alert");
  expect(screen.getAllByRole("button")).toHaveLength(7);
});
it("preserves the original account set when no technical fixture is provided", async () => {
  vi.mocked(demoApi.accounts).mockResolvedValue({
    enabled: true,
    accounts: Array.from({ length: 6 }, (_, i) => ({
      id: `org-${i}`,
      email: `org${i}@demo.ertad.local`,
      label: `Organization ${i}`,
      region: "Synthetic",
    })),
  });
  render(<DemoAccounts onLogin={vi.fn()} disabled={true} />);
  expect(await screen.findAllByRole("button")).toHaveLength(6);
  for (const button of screen.getAllByRole("button"))
    expect(button).toBeDisabled();
  expect(screen.queryByText("Technical administrator")).toBeNull();
});
