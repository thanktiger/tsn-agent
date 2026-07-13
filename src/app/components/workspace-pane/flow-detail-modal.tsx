import { useEffect, useState } from "react";
import {
  invokeUpdateFlowStream,
  type ListFlowStreamRow,
  type UpdateFlowStreamRequest,
} from "./flow-sim";

export interface FlowDetailModalProps {
  stream: ListFlowStreamRow | null; // null = 隐藏
  sessionId: string;
  onClose: () => void;
  onSaved: (didChangePlanningFields: boolean) => void;
}

/** 表单状态（对应可编辑字段）。 */
interface FormState {
  periodUs: number;
  frameBytes: number;
  count: number;
  maxLatencyUs: number | null;
  srcMac: string;
  dstMac: string;
  vlanId: number | null;
  earliestSendOffsetNs: number | null;
  latestSendOffsetNs: number | null;
}

function initialFormFromStream(stream: ListFlowStreamRow): FormState {
  return {
    periodUs: stream.periodUs,
    frameBytes: stream.frameBytes,
    count: stream.count,
    maxLatencyUs: stream.maxLatencyUs,
    srcMac: stream.srcMac ?? "",
    dstMac: stream.dstMac ?? "",
    vlanId: stream.vlanId,
    earliestSendOffsetNs: stream.earliestSendOffsetNs,
    latestSendOffsetNs: stream.latestSendOffsetNs,
  };
}

/** 流量类别 → 徽章颜色（Okabe-Ito，与流量列表同源）。 */
function classBadgeColor(cls: string): string {
  switch (cls) {
    case "ST":
      return "#0072B2";
    case "RC":
      return "#009E73";
    case "BE":
      return "#E69F00";
    default:
      return "#0072B2";
  }
}

/**
 * 流量详情弹窗（U8）：可编辑单流参数，保存后触发 onSaved 回调并关闭。
 * stream === null 时不渲染（不出 DOM）。
 * 结构照 timesync-tree-modal 先例：backdrop 用 <button>，内容区用 <section role="dialog">。
 */
export function FlowDetailModal({ stream, sessionId, onClose, onSaved }: FlowDetailModalProps) {
  const [form, setForm] = useState<FormState | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // stream 变更时重置表单状态。
  useEffect(() => {
    if (stream) {
      setForm(initialFormFromStream(stream));
      setErrorMessage(null);
    }
  }, [stream]);

  // ESC 键关闭弹窗。
  useEffect(() => {
    if (!stream) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [stream, onClose]);

  if (!stream || !form) return null;

  async function handleSave() {
    if (!stream || !form) return;
    setIsSaving(true);
    setErrorMessage(null);
    try {
      const didChangePlanningFields =
        form.periodUs !== stream.periodUs ||
        form.frameBytes !== stream.frameBytes ||
        form.count !== stream.count ||
        form.maxLatencyUs !== stream.maxLatencyUs;

      const request: UpdateFlowStreamRequest = {
        sessionId,
        streamSeq: stream.streamSeq,
        periodUs: form.periodUs,
        frameBytes: form.frameBytes,
        count: form.count,
        maxLatencyUs: form.maxLatencyUs,
        srcMac: form.srcMac || null,
        dstMac: form.dstMac || null,
        vlanId: form.vlanId,
        earliestSendOffsetNs: form.earliestSendOffsetNs,
        latestSendOffsetNs: form.latestSendOffsetNs,
      };

      await invokeUpdateFlowStream(request);
      onSaved(didChangePlanningFields);
      onClose();
    } catch (e) {
      setErrorMessage(String(e));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="flow-detail-modal-layer">
      {/* backdrop：<button> 确保键盘可访问（对齐 timesync-tree-modal 先例）。 */}
      <button
        type="button"
        className="flow-detail-modal-backdrop"
        aria-label="关闭流量详情"
        onClick={onClose}
      />
      <section
        className="flow-detail-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="flow-detail-modal-title"
      >
        <h3 id="flow-detail-modal-title">
          <span className="mono">F{stream.streamSeq}</span>
          &nbsp;
          <span
            className="flow-stream-badge"
            style={{ background: classBadgeColor(stream.class) }}
            role="img"
            aria-label={`类别 ${stream.class}`}
          >
            {stream.class}
          </span>
        </h3>

        {/* 只读信息 */}
        <div className="flow-detail-readonly">
          <span className="flow-detail-label">路由</span>
          <span className="mono">
            {stream.talker} → {stream.listener}
          </span>
          <span className="flow-detail-label">冗余</span>
          <span>{stream.redundant ? "是" : "否"}</span>
          <span className="flow-detail-label">PCP</span>
          <span className="mono">{stream.pcp}</span>
        </div>

        {/* 可编辑字段 */}
        <label>
          周期 (μs)
          <input
            type="number"
            value={form.periodUs}
            min={1}
            onChange={(e) => setForm((f) => f && { ...f, periodUs: Number(e.target.value) })}
            disabled={isSaving}
          />
        </label>

        <label>
          帧大小 (B)
          <input
            type="number"
            value={form.frameBytes}
            min={1}
            onChange={(e) => setForm((f) => f && { ...f, frameBytes: Number(e.target.value) })}
            disabled={isSaving}
          />
        </label>

        <label>
          帧数
          <input
            type="number"
            value={form.count}
            min={1}
            onChange={(e) => setForm((f) => f && { ...f, count: Number(e.target.value) })}
            disabled={isSaving}
          />
        </label>

        <label>
          最大时延 (μs)
          <input
            type="number"
            value={form.maxLatencyUs ?? ""}
            min={0}
            placeholder="（不限）"
            onChange={(e) =>
              setForm(
                (f) =>
                  f && {
                    ...f,
                    maxLatencyUs: e.target.value === "" ? null : Number(e.target.value),
                  },
              )
            }
            disabled={isSaving}
          />
        </label>

        <label>
          源 MAC
          <input
            type="text"
            value={form.srcMac}
            placeholder="（可选）"
            onChange={(e) => setForm((f) => f && { ...f, srcMac: e.target.value })}
            disabled={isSaving}
          />
        </label>

        <label>
          目的 MAC
          <input
            type="text"
            value={form.dstMac}
            placeholder="（可选）"
            onChange={(e) => setForm((f) => f && { ...f, dstMac: e.target.value })}
            disabled={isSaving}
          />
        </label>

        <label>
          VLAN ID
          <input
            type="number"
            value={form.vlanId ?? ""}
            min={0}
            placeholder="（可选）"
            onChange={(e) =>
              setForm(
                (f) =>
                  f && {
                    ...f,
                    vlanId: e.target.value === "" ? null : Number(e.target.value),
                  },
              )
            }
            disabled={isSaving}
          />
        </label>

        <label>
          最早发送偏移 (ns)
          <input
            type="number"
            value={form.earliestSendOffsetNs ?? ""}
            min={0}
            placeholder="（可选）"
            onChange={(e) =>
              setForm(
                (f) =>
                  f && {
                    ...f,
                    earliestSendOffsetNs: e.target.value === "" ? null : Number(e.target.value),
                  },
              )
            }
            disabled={isSaving}
          />
        </label>

        <label>
          最晚发送偏移 (ns)
          <input
            type="number"
            value={form.latestSendOffsetNs ?? ""}
            min={0}
            placeholder="（可选）"
            onChange={(e) =>
              setForm(
                (f) =>
                  f && {
                    ...f,
                    latestSendOffsetNs: e.target.value === "" ? null : Number(e.target.value),
                  },
              )
            }
            disabled={isSaving}
          />
        </label>

        {errorMessage && <p className="flow-detail-modal-error">{errorMessage}</p>}

        <div className="flow-detail-modal-actions">
          <button type="button" className="btn" onClick={onClose} disabled={isSaving}>
            取消
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={() => void handleSave()}
            disabled={isSaving}
          >
            {isSaving ? "保存中…" : "保存"}
          </button>
        </div>
      </section>
    </div>
  );
}
