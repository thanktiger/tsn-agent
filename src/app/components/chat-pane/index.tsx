import { Fragment, type RefObject } from "react";
import type { ChatMessage } from "../../../sessions/session-repository";
import type { ScenarioConfig } from "../../../domain/scenario-config";
import type { WorkflowState, WorkflowStageState, WorkflowStepStatus } from "../../../project/project-state";
import { redactProviderNamesForDisplay } from "../../../ui/display-redaction";
import type { AgentRunPhase } from "../../hooks/use-agent-run-controller";

const INTENT_PLACEHOLDER = "例如：我需要 4 个交换机，每个交换机连接 5 个端系统";
const STEPPER_STEPS = ["topology", "time-sync", "flow-template", "planning-export"] as const;

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
        <span className="env-badge mono">{scenarioConfig.displayName}</span>
      </div>

      {/* Phase B-α (plan v3 U9c)：流量规划暂下线告知 banner。 */}
      <div className="phase-b-banner" role="note" aria-live="polite">
        流量规划与规划导出在当前版本暂时下线，预计 v0.X 随 Phase B 回归。
      </div>

      <div className="chat-stepper" aria-label="配置步骤">
        {STEPPER_STEPS.map((step, index, steps) => {
          // Phase B-α：flow-template / planning-export 阶段 aria-disabled + tooltip
          const isFlowStage = step === "flow-template" || step === "planning-export";
          return (
            <Fragment key={step}>
              <Step
                index={`${index + 1}`}
                label={scenarioConfig.stageLabels[step]}
                status={workflow.stages[step].status}
                disabled={isFlowStage}
                disabledReason={isFlowStage ? "流量规划与规划导出在当前版本暂时下线，预计 v0.X 回归" : undefined}
              />
              {index < steps.length - 1 && (
                <span className={workflow.stages[step].status === "confirmed" ? "stepper-conn active" : "stepper-conn"} />
              )}
            </Fragment>
          );
        })}
      </div>

      <div className="messages" aria-live="polite" ref={scrollContainerRef}>
        {messages.map((message) => (
          <article
            className={[
              message.role === "user" ? "msg-user" : "msg-agent",
              message.id === pendingAssistantMessageId ? "pending" : "",
            ].filter(Boolean).join(" ")}
            key={message.id}
          >
            <span className="message-role">{message.role === "user" ? "USER" : "AGENT"}</span>
            {message.id === pendingAssistantMessageId ? (
              <AgentWaitingIndicator />
            ) : (
              <p>{message.role === "assistant" ? redactProviderNamesForDisplay(message.content) : message.content}</p>
            )}
          </article>
        ))}
      </div>

      <div className="composer">
        <label htmlFor="intent">描述你的 TSN 需求</label>
        {currentStage.status === "waiting_confirmation" && (
          <div className="stage-confirmation" role="status">
            <div>
              <strong>{scenarioConfig.stageLabels[workflow.currentStep]}等待确认</strong>
              <p>{currentStage.summary}</p>
            </div>
            <button className="btn-primary" type="button" onClick={onConfirm} disabled={isAgentRunning}>
              确认并继续
            </button>
          </div>
        )}
        <div className="composer-box">
          <textarea
            id="intent"
            aria-label="输入你的 TSN 需求"
            value={input}
            placeholder={INTENT_PLACEHOLDER}
            onChange={(event) => onInputChange(event.target.value)}
            rows={3}
          />
          <button type="button" aria-label="生成规划草案" onClick={onSubmit} disabled={isAgentRunning || !input.trim()}>
            <TelegramSendIcon />
          </button>
        </div>
      </div>
    </section>
  );
}

export function AgentRunStatusBar({ elapsedSeconds, phase }: { elapsedSeconds: number; phase: AgentRunPhase }) {
  const message = getAgentRunStatusMessage(phase);

  return (
    <div className={`agent-run-status ${phase}`} role="status" aria-live="polite" data-testid="agent-run-status">
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
  /** Phase B-α (plan v3 U9c)：标记暂下线阶段（flow-template / planning-export）。 */
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
