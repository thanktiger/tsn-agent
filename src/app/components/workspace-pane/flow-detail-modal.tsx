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

/** 表单状态（对应可编辑字段，参考规范图三分组）。 */
interface FormState {
  name: string;
  // 数据帧规范
  dstMac: string;
  srcMac: string;
  dstIp: string;
  srcIp: string;
  dstL4Port: number | null;
  srcL4Port: number | null;
  l4Protocol: string;
  vlanId: number | null;
  // 流量规范
  periodUs: number;
  count: number;
  frameBytes: number;
  earliestSendOffsetNs: number | null;
  latestSendOffsetNs: number | null;
  jitterNs: number | null;
  // 网络需求
  maxLatencyUs: number | null;
}

function initialFormFromStream(stream: ListFlowStreamRow): FormState {
  return {
    name: stream.name ?? "",
    dstMac: stream.dstMac ?? "",
    srcMac: stream.srcMac ?? "",
    dstIp: stream.dstIp ?? "",
    srcIp: stream.srcIp ?? "",
    dstL4Port: stream.dstL4Port,
    srcL4Port: stream.srcL4Port,
    l4Protocol: stream.l4Protocol ?? "UDP",
    vlanId: stream.vlanId,
    periodUs: stream.periodUs,
    count: stream.count,
    frameBytes: stream.frameBytes,
    earliestSendOffsetNs: stream.earliestSendOffsetNs,
    latestSendOffsetNs: stream.latestSendOffsetNs,
    jitterNs: stream.jitterNs,
    maxLatencyUs: stream.maxLatencyUs,
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
 * 流量详情弹窗（U8 → 参考规范图重构）：编辑单流参数，保存后触发 onSaved 回调并关闭。
 * 字段按 数据帧规范 / 流量规范 / 网络需求 三分组；设备级标识默认值由后端推导返回，
 * 保存后落库。stream === null 时不渲染（不出 DOM）。
 * 结构照 timesync-tree-modal 先例：backdrop 用 <button>，内容区用 <section role="dialog">。
 */
export function FlowDetailModal({ stream, sessionId, onClose, onSaved }: FlowDetailModalProps) {
  const [form, setForm] = useState<FormState | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // stream 变更时重置表单状态；stream 清空时擦除旧表单（避免弹窗再开时闪旧值）。
  useEffect(() => {
    if (stream) {
      setForm(initialFormFromStream(stream));
      setErrorMessage(null);
    } else {
      setForm(null);
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

  const nodePathText =
    stream.nodePath.length > 0
      ? stream.nodePath.join(" → ")
      : `${stream.talker} → ${stream.listener}`;

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
        name: form.name || null,
        jitterNs: form.jitterNs,
        srcIp: form.srcIp || null,
        dstIp: form.dstIp || null,
        srcL4Port: form.srcL4Port,
        dstL4Port: form.dstL4Port,
        l4Protocol: form.l4Protocol || null,
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

  /** number 输入 onChange 工具：空串 → null。 */
  function numberOrNull(value: string): number | null {
    return value === "" ? null : Number(value);
  }

  return (
    <div className="flow-detail-modal-layer">
      {/* backdrop：<button> 确保键盘可访问（对齐 timesync-tree-modal 先例）。 */}
      <button
        type="button"
        className="flow-detail-modal-backdrop"
        aria-label="关闭流量详情"
        onClick={onClose}
        disabled={isSaving}
      />
      <section
        className="flow-detail-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="flow-detail-modal-title"
      >
        <h3 id="flow-detail-modal-title">
          编辑流量&nbsp;
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

        {/* 节点路径 chip */}
        <div className="flow-detail-path mono">{nodePathText}</div>

        <div className="flow-detail-grid">
          <label>
            流id
            <input type="text" value={`F${stream.streamSeq}`} disabled />
          </label>
          <label>
            流名称
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm((f) => f && { ...f, name: e.target.value })}
              disabled={isSaving}
            />
          </label>
        </div>

        <h4 className="flow-detail-section-title">数据帧规范</h4>
        <div className="flow-detail-grid three">
          <label>
            目的MAC
            <input
              type="text"
              value={form.dstMac}
              onChange={(e) => setForm((f) => f && { ...f, dstMac: e.target.value })}
              disabled={isSaving}
            />
          </label>
          <label>
            源MAC
            <input
              type="text"
              value={form.srcMac}
              onChange={(e) => setForm((f) => f && { ...f, srcMac: e.target.value })}
              disabled={isSaving}
            />
          </label>
          <label>
            目的IP
            <input
              type="text"
              value={form.dstIp}
              onChange={(e) => setForm((f) => f && { ...f, dstIp: e.target.value })}
              disabled={isSaving}
            />
          </label>
          <label>
            源IP
            <input
              type="text"
              value={form.srcIp}
              onChange={(e) => setForm((f) => f && { ...f, srcIp: e.target.value })}
              disabled={isSaving}
            />
          </label>
          <label>
            目的端口
            <input
              type="number"
              value={form.dstL4Port ?? ""}
              min={0}
              onChange={(e) =>
                setForm((f) => f && { ...f, dstL4Port: numberOrNull(e.target.value) })
              }
              disabled={isSaving}
            />
          </label>
          <label>
            源端口
            <input
              type="number"
              value={form.srcL4Port ?? ""}
              min={0}
              onChange={(e) =>
                setForm((f) => f && { ...f, srcL4Port: numberOrNull(e.target.value) })
              }
              disabled={isSaving}
            />
          </label>
          <label>
            协议类型
            <select
              value={form.l4Protocol}
              onChange={(e) => setForm((f) => f && { ...f, l4Protocol: e.target.value })}
              disabled={isSaving}
            >
              <option value="UDP">UDP</option>
              <option value="TCP">TCP</option>
            </select>
          </label>
          <label>
            PCP优先级
            <input type="number" value={stream.pcp} disabled title="PCP 由流类别派生，不可改" />
          </label>
          <label>
            VLANid
            <input
              type="number"
              value={form.vlanId ?? ""}
              min={0}
              onChange={(e) => setForm((f) => f && { ...f, vlanId: numberOrNull(e.target.value) })}
              disabled={isSaving}
            />
          </label>
        </div>

        <h4 className="flow-detail-section-title">流量规范</h4>
        <div className="flow-detail-grid three">
          <label>
            帧发送间隔(μs)
            <input
              type="number"
              value={form.periodUs}
              min={1}
              onChange={(e) => setForm((f) => f && { ...f, periodUs: Number(e.target.value) })}
              disabled={isSaving}
            />
          </label>
          <label>
            间隔最大帧数量
            <input
              type="number"
              value={form.count}
              min={1}
              onChange={(e) => setForm((f) => f && { ...f, count: Number(e.target.value) })}
              disabled={isSaving}
            />
          </label>
          <label>
            最大帧长度(B)
            <input
              type="number"
              value={form.frameBytes}
              min={1}
              onChange={(e) => setForm((f) => f && { ...f, frameBytes: Number(e.target.value) })}
              disabled={isSaving}
            />
          </label>
          <label>
            最早发送偏移(ns)
            <input
              type="number"
              value={form.earliestSendOffsetNs ?? ""}
              min={0}
              onChange={(e) =>
                setForm((f) => f && { ...f, earliestSendOffsetNs: numberOrNull(e.target.value) })
              }
              disabled={isSaving}
            />
          </label>
          <label>
            最晚发送偏移(ns)
            <input
              type="number"
              value={form.latestSendOffsetNs ?? ""}
              min={0}
              onChange={(e) =>
                setForm((f) => f && { ...f, latestSendOffsetNs: numberOrNull(e.target.value) })
              }
              disabled={isSaving}
            />
          </label>
          <label>
            抖动(ns)
            <input
              type="number"
              value={form.jitterNs ?? ""}
              min={0}
              onChange={(e) =>
                setForm((f) => f && { ...f, jitterNs: numberOrNull(e.target.value) })
              }
              disabled={isSaving}
            />
          </label>
        </div>

        <h4 className="flow-detail-section-title">网络需求</h4>
        <div className="flow-detail-grid three">
          <label>
            最大延迟(μs)
            <input
              type="number"
              value={form.maxLatencyUs ?? ""}
              min={0}
              placeholder="（不限）"
              onChange={(e) =>
                setForm((f) => f && { ...f, maxLatencyUs: numberOrNull(e.target.value) })
              }
              disabled={isSaving}
            />
          </label>
          <label>
            冗余
            <input
              type="text"
              value={stream.redundant ? "是（802.1CB 双平面）" : "否"}
              disabled
              title="冗余由流类别（RC）决定，不可改"
            />
          </label>
        </div>

        {errorMessage && <p className="flow-detail-modal-error">{errorMessage}</p>}

        <div className="flow-detail-modal-actions">
          <span className="flow-detail-modal-hint">保存后需要重新生成规划结果</span>
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
