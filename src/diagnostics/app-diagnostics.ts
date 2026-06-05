import type { TsnSession } from "../sessions/session-repository";
import type { DiagnosticLogRepository } from "./diagnostic-log-repository";
import { summarizeText, type DiagnosticLogInput } from "./diagnostic-log";

export function logDiagnostic(repository: DiagnosticLogRepository, input: DiagnosticLogInput): void {
  void repository.append(input);
}

export function sessionSummary(session: TsnSession) {
  return {
    title: session.title,
    messageCount: session.messages.length,
    eventCount: session.agentEvents.length,
    workflowStep: session.workflow.currentStep,
    workflowStatus: session.workflow.stages[session.workflow.currentStep]?.status,
    scenarioConfigId: session.workflow.scenarioConfigId,
    topologyMutationId: session.topologyMutationId,
    claudeSessionId: session.claudeSessionId,
  };
}

export function userIntentPreview(value: string) {
  return {
    preview: summarizeText(value),
    charCount: value.length,
  };
}
