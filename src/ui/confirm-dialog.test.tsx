import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "./confirm-dialog";

describe("ConfirmDialog", () => {
  function renderDialog(overrides: Partial<Parameters<typeof ConfirmDialog>[0]> = {}) {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const utils = render(
      <ConfirmDialog
        open
        title="重建拓扑"
        body="将从原始数据重建，该会话现有拓扑数据将被替换。"
        confirmLabel="重建"
        danger
        onConfirm={onConfirm}
        onCancel={onCancel}
        {...overrides}
      />,
    );
    return { onConfirm, onCancel, ...utils };
  }

  it("renders title, body and verb-style buttons when open", () => {
    renderDialog();
    expect(screen.getByRole("alertdialog", { name: "重建拓扑" })).toBeInTheDocument();
    expect(screen.getByText(/将被替换/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重建" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "取消" })).toBeInTheDocument();
  });

  it("renders nothing when closed", () => {
    renderDialog({ open: false });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("fires onConfirm exactly once per click", () => {
    const { onConfirm, onCancel } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "重建" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("fires onCancel on cancel click and on Escape", () => {
    const { onConfirm, onCancel } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onCancel).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("removes the Escape listener after the dialog closes", () => {
    const { onCancel, rerender } = renderDialog();
    rerender(
      <ConfirmDialog
        open={false}
        title="重建拓扑"
        body="x"
        confirmLabel="重建"
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).not.toHaveBeenCalled();
  });
});
