/**
 * 轻量确认弹窗（plan 2026-06-05-002 U3）。受控组件：open 为 false 时不渲染。
 * 按钮文案由调用方提供且应动词化（R16 惯例，如「重建」「取消」）。
 * Escape 触发 onCancel；遮罩点击不关闭（危险操作要求显式选择）。
 */

import { useEffect } from "react";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** 危险操作（数据替换/删除）时确认按钮用警示样式。 */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel = "取消",
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onCancel();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onCancel]);

  if (!open) {
    return null;
  }

  return (
    <div className="confirm-dialog-overlay" role="presentation">
      <div className="confirm-dialog" role="alertdialog" aria-modal="true" aria-label={title}>
        <strong className="confirm-dialog-title">{title}</strong>
        <p className="confirm-dialog-body">{body}</p>
        <div className="confirm-dialog-actions">
          <button type="button" className="confirm-dialog-cancel" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={danger ? "confirm-dialog-confirm danger" : "confirm-dialog-confirm"}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
