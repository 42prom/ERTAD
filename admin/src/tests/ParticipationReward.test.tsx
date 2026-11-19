import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import ParticipationReward, {
  type RewardChoice,
} from "../components/ParticipationReward";

vi.mock("../components/useConsolePreferences", () => ({
  useConsolePreferences: () => ({ language: "en" }),
}));
function Form({ options }: { options: RewardChoice[] }) {
  const [value, setValue] = useState<string | null>(null);
  return (
    <MemoryRouter>
      <form aria-label="Create work">
        <ParticipationReward
          value={value}
          onChange={setValue}
          options={options}
          label="Participation reward"
        />
        <output aria-label="Selected reward">{value ?? "none"}</output>
      </form>
    </MemoryRouter>
  );
}
it("requires an explicit approved rule when points are enabled and clears it when opted out", () => {
  render(
    <Form
      options={[
        { id: "rule", title: "Participation", amount: 10, memberMonthCap: 50 },
      ]}
    />,
  );
  const form = screen.getByRole("form") as HTMLFormElement;
  expect(form.checkValidity()).toBe(true);
  fireEvent.click(
    screen.getByRole("radio", { name: "Assign points", exact: true }),
  );
  expect(form.checkValidity()).toBe(false);
  expect(screen.getByLabelText("Selected reward")).toHaveTextContent("none");
  fireEvent.change(screen.getByLabelText("Participation reward"), {
    target: { value: "rule" },
  });
  expect(form.checkValidity()).toBe(true);
  expect(screen.getByLabelText("Selected reward")).toHaveTextContent("rule");
  fireEvent.click(
    screen.getByRole("radio", { name: "Do not assign points", exact: true }),
  );
  expect(screen.getByLabelText("Selected reward")).toHaveTextContent("none");
  fireEvent.click(
    screen.getByRole("radio", { name: "Assign points", exact: true }),
  );
  expect(form.checkValidity()).toBe(false);
});
it("does not silently create unrewarded work when points were requested but no approved rule exists", () => {
  render(<Form options={[]} />);
  fireEvent.click(
    screen.getByRole("radio", { name: "Assign points", exact: true }),
  );
  expect(screen.getByRole("status", { name: "" })).toHaveTextContent(
    "No active rule",
  );
  expect((screen.getByRole("form") as HTMLFormElement).checkValidity()).toBe(
    false,
  );
});
