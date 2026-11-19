import { it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import TaskMaterials from "../components/TaskMaterials";
import type { WorkDetail } from "../api/work";
vi.mock("../components/useConsolePreferences", () => ({
  useConsolePreferences: () => ({ language: "en" }),
}));
const detail = {
  id: "task",
  version: 3,
  canManage: true,
  status: "open",
  materialLinks: [{ title: "Instructions", url: "https://example.org/guide" }],
} as WorkDetail;
it("shows a destination without prefetching and protects external navigation", () => {
  render(
    <TaskMaterials
      detail={detail}
      organizationId="org"
      locked={false}
      onWrite={vi.fn()}
    />,
  );
  const link = screen.getByRole("link", { name: /Instructions/ });
  expect(link).toHaveAttribute("href", "https://example.org/guide");
  expect(link).toHaveAttribute("rel", "noopener noreferrer");
  expect(link).toHaveAttribute("referrerpolicy", "no-referrer");
  expect(screen.getByText(/example.org/)).toBeInTheDocument();
});
it("never renders executable links even from malformed response data", () => {
  render(
    <TaskMaterials
      detail={{
        ...detail,
        materialLinks: [{ title: "Invalid", url: "javascript:alert(1)" }],
      }}
      organizationId="org"
      locked={false}
      onWrite={vi.fn()}
    />,
  );
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
});
it("hides editing from readers and closed tasks", () => {
  const { rerender } = render(
    <TaskMaterials
      detail={{ ...detail, canManage: false }}
      organizationId="org"
      locked={false}
      onWrite={vi.fn()}
    />,
  );
  expect(
    screen.queryByRole("button", { name: "Manage links" }),
  ).not.toBeInTheDocument();
  rerender(
    <TaskMaterials
      detail={{ ...detail, status: "completed" }}
      organizationId="org"
      locked={false}
      onWrite={vi.fn()}
    />,
  );
  expect(
    screen.queryByRole("button", { name: "Manage links" }),
  ).not.toBeInTheDocument();
});
it("validates link schemes and submits a bounded versioned replacement", () => {
  const onWrite = vi.fn().mockResolvedValue(undefined);
  render(
    <TaskMaterials
      detail={detail}
      organizationId="org"
      locked={false}
      onWrite={onWrite}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Manage links" }));
  fireEvent.change(screen.getByLabelText("URL 1"), {
    target: { value: "https://user:secret@example.org" },
  });
  expect(screen.getByRole("button", { name: "Save materials" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("URL 1"), {
    target: { value: "https://example.org/updated" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save materials" }));
  expect(onWrite).toHaveBeenCalledWith(
    expect.objectContaining({
      operation: "materials",
      id: "task",
      version: 3,
      organizationId: "org",
      key: expect.any(String),
      links: [{ title: "Instructions", url: "https://example.org/updated" }],
    }),
  );
});
it("locks an uncertain draft and allows an explicit empty replacement", () => {
  const onWrite = vi.fn().mockResolvedValue(undefined);
  const { rerender } = render(
    <TaskMaterials
      detail={detail}
      organizationId="org"
      locked={false}
      onWrite={onWrite}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Manage links" }));
  rerender(
    <TaskMaterials
      detail={detail}
      organizationId="org"
      locked
      onWrite={onWrite}
    />,
  );
  expect(screen.getByLabelText("URL 1")).toBeDisabled();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  rerender(
    <TaskMaterials
      detail={detail}
      organizationId="org"
      locked={false}
      onWrite={onWrite}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Remove link 1" }));
  fireEvent.click(screen.getByRole("button", { name: "Save materials" }));
  expect(onWrite).toHaveBeenCalledWith(expect.objectContaining({ links: [] }));
});
