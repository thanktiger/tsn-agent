import { Fragment, type RefObject } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ScenarioConfig } from "../../../domain/scenario-config";
import type {
  WorkflowStageState,
  WorkflowState,
  WorkflowStepStatus,
} from "../../../project/project-state";
import type { ChatMessage } from "../../../sessions/session-repository";
import { redactProviderNamesForDisplay } from "../../../ui/display-redaction";
import type { AgentRunPhase } from "../../hooks/use-agent-run-controller";
import { ToolCallCard } from "./tool-call-card";

const STEPPER_STEPS = ["topology", "time-sync", "flow-template"] as const;

/** 验证口径 → 给用户看的中文标签（"绿/红"永远带它出现，杜绝误读为时延已保证）。 */
function caliberLabel(caliber: string): string {
  switch (caliber) {
    case "structural_only":
      return "仅结构级";
    case "loadability_only":
      return "仅能加载运行";
    case "schedulability":
      return "已验可调度性";
    default:
      return "未知口径";
  }
}

export interface ChatPaneProps {
  scenarioConfig: ScenarioConfig;
  workflow: WorkflowState;
  currentStage: WorkflowStageState;
  messages: ChatMessage[];
  pendingAssistantMessageId: string | undefined;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  input: string;
  isAgentRunning: boolean;
  onInputChange: (value: string) => void;
  onSubmit: () => void;
  onConfirm: () => void;
}

export function ChatPane({
  scenarioConfig,
  workflow,
  currentStage,
  messages,
  pendingAssistantMessageId,
  scrollContainerRef,
  input,
  isAgentRunning,
  onInputChange,
  onSubmit,
  onConfirm,
}: ChatPaneProps) {
  return (
    <section className="chat-pane" aria-label="对话区">
      <div className="project-strip">
        <span className="project-name">当前规划</span>
      </div>

      <div className="chat-stepper" role="group" aria-label="配置步骤">
        {STEPPER_STEPS.map((step, index, steps) => {
          // Phase B-α：flow-template 阶段 aria-disabled + tooltip
          const isFlowStage = step === "flow-template";
          return (
            <Fragment key={step}>
              <Step
                index={`${index + 1}`}
                label={scenarioConfig.stageLabels[step]}
                status={workflow.stages[step].status}
                disabled={isFlowStage}
                disabledReason={
                  isFlowStage ? "流量规划在当前版本暂时下线，预计 Phase B 回归" : undefined
                }
              />
              {index < steps.length - 1 && (
                <span
                  className={
                    workflow.stages[step].status === "confirmed"
                      ? "stepper-conn active"
                      : "stepper-conn"
                  }
                />
              )}
            </Fragment>
          );
        })}
      </div>

      <div className="messages" aria-live="polite" ref={scrollContainerRef}>
        {messages.map((message) => {
          // 结构验证未通过的消息区分渲染：让用户一眼看出是"被拦下、去修"而非普通建议。
          const verifyBlock =
            message.role === "assistant" && message.verification && !message.verification.ok
              ? message.verification
              : undefined;
          // 远端连不上（inet_unreachable）是环境问题：走中性「暂时无法验证」外观，不套红「验证未通过」
          // （否则误导用户去改一个其实没问题的拓扑）。结构错 / 跑不起来才走红 block。
          const isEnvIssue =
            verifyBlock?.errors.some((error) => error.code === "inet_unreachable") ?? false;
          const showRedBlock = Boolean(verifyBlock) && !isEnvIssue;
          return (
            <article
              className={[
                message.role === "user" ? "msg-user" : "msg-agent",
                showRedBlock ? "msg-verify-block" : "",
                verifyBlock && isEnvIssue ? "msg-verify-pending" : "",
                message.id === pendingAssistantMessageId ? "pending" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              key={message.id}
            >
              <span className="message-role">{message.role === "user" ? "USER" : "AGENT"}</span>
              {verifyBlock && (
                <div className="verify-header">
                  <span
                    className={
                      isEnvIssue ? "caliber-chip caliber-pending" : "caliber-chip caliber-block"
                    }
                  >
                    {isEnvIssue ? "暂时无法验证" : "验证未通过"} ·{" "}
                    {caliberLabel(verifyBlock.caliber)}
                  </span>
                </div>
              )}
              {/* Plan 2026-06-10-001 U5：工具事件常先于首个文本 chunk（此时仍是 pending
                态）——卡片在两个分支都渲染；pending 时卡片在上、等待指示器在下。 */}
              {message.role === "assistant" &&
                message.toolCalls &&
                message.toolCalls.length > 0 && (
                  <div className="tool-call-list">
                    {message.toolCalls.map((record) => (
                      <ToolCallCard key={record.id} record={record} />
                    ))}
                  </div>
                )}
              {message.id === pendingAssistantMessageId ? (
                <AgentWaitingIndicator />
              ) : message.role === "assistant" ? (
                // assistant 输出按 markdown 渲染；用户输入保持纯文本不做解释。
                <div className="msg-markdown">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {redactProviderNamesForDisplay(message.content)}
                  </ReactMarkdown>
                </div>
              ) : (
                <p>{message.content}</p>
              )}
            </article>
          );
        })}
      </div>

      <div className="composer">
        <label htmlFor="intent">描述你的 TSN 需求</label>
        {(currentStage.status === "waiting_confirmation" || workflow.pendingStageChange) && (
          <div className="stage-confirmation" role="status">
            <div>
              {workflow.pendingStageChange ? (
                <>
                  <strong>确认切回{scenarioConfig.stageLabels[workflow.pendingStageChange]}</strong>
                  <p>
                    {workflow.pendingStageChange === "topology"
                      ? "切回会按你的新要求覆盖重建当前拓扑，其后已完成的阶段也会重新来过。"
                      : "切回会让其后已完成的阶段重新来过。"}
                    确认请点右侧按钮。
                  </p>
                </>
              ) : (
                <>
                  <strong>{scenarioConfig.stageLabels[workflow.currentStep]}等待确认</strong>
                  <p>{currentStage.summary}</p>
                </>
              )}
            </div>
            <button
              className="btn-primary"
              type="button"
              onClick={onConfirm}
              disabled={isAgentRunning}
            >
              确认并继续
            </button>
          </div>
        )}
        <div className="composer-box">
          <textarea
            id="intent"
            aria-label="输入你的 TSN 需求"
            value={input}
            placeholder={`例如：${scenarioConfig.exampleIntent}`}
            onChange={(event) => onInputChange(event.target.value)}
            onKeyDown={(event) => {
              // IME 选词中的 Enter 是确认候选，不发送。
              if (event.key !== "Enter" || event.nativeEvent.isComposing) {
                return;
              }

              // Cmd/Ctrl+Enter 插入换行（浏览器对修饰 Enter 默认不插，手动插入并复位光标）。
              if (event.metaKey || event.ctrlKey) {
                event.preventDefault();
                const target = event.currentTarget;
                const start = target.selectionStart ?? input.length;
                const end = target.selectionEnd ?? input.length;
                onInputChange(`${input.slice(0, start)}\n${input.slice(end)}`);
                requestAnimationFrame(() => {
                  target.selectionStart = start + 1;
                  target.selectionEnd = start + 1;
                });
                return;
              }

              // Shift/Alt+Enter 保留默认换行。
              if (event.shiftKey || event.altKey) {
                return;
              }

              // 纯 Enter 发送（与发送按钮同条件）。
              event.preventDefault();
              if (!isAgentRunning && input.trim()) {
                onSubmit();
              }
            }}
            rows={3}
          />
          <button
            type="button"
            aria-label="生成规划草案"
            onClick={onSubmit}
            disabled={isAgentRunning || !input.trim()}
          >
            <TelegramSendIcon />
          </button>
        </div>
      </div>
    </section>
  );
}

export function AgentRunStatusBar({
  elapsedSeconds,
  phase,
}: {
  elapsedSeconds: number;
  phase: AgentRunPhase;
}) {
  const message = getAgentRunStatusMessage(phase);

  return (
    <div
      className={`agent-run-status ${phase}`}
      role="status"
      aria-live="polite"
      data-testid="agent-run-status"
    >
      <span className="agent-waiting-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span>{message}</span>
      <span className="agent-run-elapsed mono">已运行 {elapsedSeconds} 秒</span>
    </div>
  );
}

function getAgentRunStatusMessage(phase: AgentRunPhase): string {
  if (phase === "waiting") {
    return "智能助手仍在处理，可能正在等待工具或子任务返回";
  }

  if (phase === "streaming") {
    return "智能助手正在持续推理，结果会继续更新";
  }

  return "智能助手正在连接并准备当前会话上下文";
}

function Step({
  index,
  label,
  status,
  disabled,
  disabledReason,
}: {
  index: string;
  label: string;
  status: WorkflowStepStatus;
  /** Phase B-α (plan v3 U9c)：标记暂下线阶段（flow-template）。 */
  disabled?: boolean;
  /** tooltip 文案，鼠标 hover + screen reader 都可以读。 */
  disabledReason?: string;
}) {
  const className = status === "confirmed" ? "passed" : status;

  return (
    <div
      className={`stepper-item ${className}${disabled ? " disabled" : ""}`}
      aria-disabled={disabled || undefined}
      title={disabled ? disabledReason : undefined}
    >
      <span className="si-num">{index}</span>
      <span className="si-label">{label}</span>
    </div>
  );
}

function AgentWaitingIndicator() {
  return (
    <div className="agent-waiting" role="status" aria-live="polite">
      <span className="agent-waiting-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span>正在连接智能助手，并结合当前会话上下文生成下一步规划</span>
    </div>
  );
}

function TelegramSendIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      className="telegram-send-icon"
    >
      <path
        fill="currentColor"
        d="M20.68 4.44c.42-.18.85.18.73.62l-3.78 14.18c-.11.41-.61.57-.95.31l-5.38-4.02-2.76 2.66c-.29.28-.78.13-.86-.27l-.95-4.73-4.36-1.36c-.44-.14-.48-.76-.06-.96L20.68 4.44Z"
      />
      <path
        fill="var(--accent)"
        d="M8.92 12.95 17.8 7.4c.18-.11.36.13.21.28l-7.32 7.04-.29 2.73-1.48-4.5Z"
      />
    </svg>
  );
}
