import { useEffect, useRef, useState } from "react";
import {
  type GetFlowPathCandidatesResult,
  invokeGetFlowPathCandidates,
  invokeUpdateFlowStream,
  type ListFlowStreamRow,
  parseExplicitPathLinkSeqs,
  parseRedundantNodePaths,
  type UpdateFlowStreamRequest,
} from "./flow-sim";

export interface FlowDetailModalProps {
  stream: ListFlowStreamRow | null; // null = 隐藏
  sessionId: string;
  onClose: () => void;
  onSaved: (didChangePlanningFields: boolean) => void;
  /** 候选路径读通道（R16 路径下拉；测试可注入替身）。 */
  getPathCandidates?: (
    sessionId: string,
    talker: string,
    listener: string,
  ) => Promise<GetFlowPathCandidatesResult>;
  /** 画布路径预览联动（R16）：下拉选中变化时回调 linkSeqs；null=系统自动/关弹窗清除。 */
  onPreviewPath?: (linkSeqs: number[] | null) => void;
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

/** 路径选择值："auto"=系统自动 / "current"=当前显式指定（不在候选中，可能已失效）/
 * `c{idx}`=候选下标。 */
type PathSelection = "auto" | "current" | `c${number}`;

/** 候选查询态。 */
type CandidatesState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "loaded"; result: GetFlowPathCandidatesResult };

/** 路径选项文本：显示名 join "→"，超 40 字符省略（title 给完整文案）。 */
export function pathOptionLabel(names: string[]): { label: string; full: string } {
  const full = names.join("→");
  return { label: full.length > 40 ? `${full.slice(0, 40)}…` : full, full };
}

/**
 * 流量详情弹窗（U8 → 参考规范图重构）：编辑单流参数，保存后触发 onSaved 回调并关闭。
 * 字段按 路径 / 数据帧规范 / 流量规范 / 网络需求 分组；设备级标识默认值由后端推导返回，
 * 保存后落库。stream === null 时不渲染（不出 DOM）。
 * 结构照 timesync-tree-modal 先例：backdrop 用 <button>，内容区用 <section role="dialog">。
 */
export function FlowDetailModal({
  stream,
  sessionId,
  onClose,
  onSaved,
  getPathCandidates = invokeGetFlowPathCandidates,
  onPreviewPath,
}: FlowDetailModalProps) {
  const [form, setForm] = useState<FormState | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // R16 路径下拉状态：候选查询 + 当前选中 + 打开时的初始选中（diff 判是否带路径变更）。
  const [candidates, setCandidates] = useState<CandidatesState>({ status: "loading" });
  const [pathSelection, setPathSelection] = useState<PathSelection>("auto");
  const initialSelectionRef = useRef<PathSelection>("auto");
  // onPreviewPath 经 ref 消费，避免回调身份变化触发副作用重跑。
  const previewRef = useRef(onPreviewPath);
  previewRef.current = onPreviewPath;

  // stream 变更时重置表单状态；stream 清空时擦除旧表单（避免弹窗再开时闪旧值）+ 清预览。
  useEffect(() => {
    if (stream) {
      setForm(initialFormFromStream(stream));
      setErrorMessage(null);
    } else {
      setForm(null);
      previewRef.current?.(null);
    }
  }, [stream]);

  // R16：打开弹窗拉候选（仅 ST/BE；RC 只读展示不拉）；载入后按 stream.paths 定位初始选中。
  const streamSeq = stream?.streamSeq;
  const streamClass = stream?.class;
  const talker = stream?.talker;
  const listener = stream?.listener;
  const streamPaths = stream?.paths ?? null;
  useEffect(() => {
    setCandidates({ status: "loading" });
    setPathSelection("auto");
    initialSelectionRef.current = "auto";
    if (streamSeq === undefined || streamClass === "RC" || !talker || !listener) return;
    let cancelled = false;
    getPathCandidates(sessionId, talker, listener)
      .then((result) => {
        if (cancelled) return;
        setCandidates({ status: "loaded", result });
        const explicit = parseExplicitPathLinkSeqs(streamPaths);
        let initial: PathSelection = "auto";
        if (explicit) {
          const idx = result.candidates.findIndex(
            (c) =>
              c.linkSeqs.length === explicit.length &&
              c.linkSeqs.every((s, i) => s === explicit[i]),
          );
          initial = idx >= 0 ? (`c${idx}` as PathSelection) : "current";
        }
        setPathSelection(initial);
        initialSelectionRef.current = initial;
      })
      .catch(() => {
        if (!cancelled) setCandidates({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [streamSeq, streamClass, talker, listener, streamPaths, sessionId, getPathCandidates]);

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

  /** 下拉选中变化：更新选中 + 画布预览联动（auto → null；候选 → 其 linkSeqs；
   * current → 库里显式 linkSeqs）。 */
  function handlePathSelect(value: PathSelection) {
    setPathSelection(value);
    if (value === "auto") {
      previewRef.current?.(null);
    } else if (value === "current") {
      previewRef.current?.(parseExplicitPathLinkSeqs(streamPaths));
    } else if (candidates.status === "loaded") {
      const idx = Number(value.slice(1));
      previewRef.current?.(candidates.result.candidates[idx]?.linkSeqs ?? null);
    }
  }

  async function handleSave() {
    if (!stream || !form) return;
    setIsSaving(true);
    setErrorMessage(null);
    try {
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

      // R16 路径三态：选中≠打开时初值才带变更——候选 → pathLinkSeqs；
      // 改回系统自动且原来有显式 → clearPath；未动不带。
      const sel = pathSelection;
      if (sel !== initialSelectionRef.current) {
        if (sel === "auto") {
          request.clearPath = true;
        } else if (sel.startsWith("c") && candidates.status === "loaded") {
          const linkSeqs = candidates.result.candidates[Number(sel.slice(1))]?.linkSeqs;
          if (linkSeqs) request.pathLinkSeqs = linkSeqs;
        }
      }

      // didChange 吃服务端判定（KTD14：与置 stale 同源，前端不再自行 diff）。
      const result = await invokeUpdateFlowStream(request);
      previewRef.current?.(null);
      onSaved(result.planningFieldsChanged);
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

        {/* R16 路径区：ST/BE 候选下拉（默认系统自动）；RC 只读展示双冗余路径。 */}
        <h4 className="flow-detail-section-title">路径</h4>
        {stream.class === "RC" ? (
          <RcPathReadonly paths={stream.paths} />
        ) : (
          <div className="flow-detail-grid">
            <label>
              指定路径
              <select
                value={pathSelection}
                onChange={(e) => handlePathSelect(e.target.value as PathSelection)}
                disabled={isSaving || candidates.status === "loading"}
              >
                <option value="auto">系统自动（最短路）</option>
                {pathSelection === "current" && (
                  <option value="current" title="当前库内显式指定，不在候选列表中">
                    当前指定路径（可能已失效）
                  </option>
                )}
                {candidates.status === "loaded" &&
                  candidates.result.candidates.map((c, idx) => {
                    const { label, full } = pathOptionLabel(c.nodePathNames);
                    return (
                      <option key={c.linkSeqs.join("-")} value={`c${idx}`} title={full}>
                        {label}
                      </option>
                    );
                  })}
                {candidates.status === "loaded" && candidates.result.truncated && (
                  <option disabled value="__truncated">
                    还有未列出路径
                  </option>
                )}
              </select>
            </label>
            {candidates.status === "error" && (
              <p className="flow-detail-modal-hint">候选路径加载失败，仍可按系统自动保存。</p>
            )}
          </div>
        )}

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

/** RC 路径只读区（R16）：展示 A/B 双冗余路径文本 + 不可手选说明。 */
function RcPathReadonly({ paths }: { paths: string | null }) {
  const routes = parseRedundantNodePaths(paths);
  return (
    <div className="flow-detail-rc-paths">
      <div className="mono">路径A：{routes ? routes[0].join("→") : "—"}</div>
      <div className="mono">路径B：{routes ? routes[1].join("→") : "—"}</div>
      <p className="flow-detail-modal-hint">FRER 双路径由算法保证不相交，不可手选。</p>
    </div>
  );
}
