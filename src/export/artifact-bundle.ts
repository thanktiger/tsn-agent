/**
 * @deprecated Phase B (plan v3 U9b 范围)：artifact bundle 仍在 UI 总入口（App.tsx）
 * 与 project-exporter / app-diagnostics 使用，整体改造（拆分为 sidecar-driven artifact
 * + summary）是 Phase B 后续 PR 范围。当前 UI 中 flow 相关 bundle 字段在
 * Phase B-α 已 grayscale，artifact bundle 仅留 topology / ned / react-flow 三件套。
 */
import type { CanonicalTsnProjectV0 } from "../domain/canonical";
import { validateCanonicalProject } from "../domain/validation";
import { exportOmnetppIni } from "./ini-exporter";
import { exportInetTrafficIni } from "./inet-traffic-exporter";
import { exportInetPlannerGcl } from "./inet-gcl-exporter";
import { NED_CONTRACT } from "./ned-contract";
import { exportNed } from "./ned-exporter";
import { exportPlannerInput } from "./planner-exporter";
import { exportReactFlowTopology } from "./react-flow-exporter";
import type { PlannerResultSnapshot, PlannerStartRequest } from "../planner/planner-contract";

export type ArtifactPurpose =
  | "simulation-inet"
  | "workspace-visualization"
  | "planner-input"
  | "planner-request"
  | "planner-output"
  | "planner-gcl"
  | "manifest";

export interface ExportedArtifact {
  path: string;
  purpose: ArtifactPurpose;
  label: string;
  observedExternal?: boolean;
  content: string;
}

export interface ExportManifest {
  schemaVersion: "tsn-agent.export-manifest.v0";
  projectId: string;
  generatedAt: string;
  files: Array<{
    path: string;
    purpose: ArtifactPurpose;
    label: string;
    observedExternal?: boolean;
  }>;
}

export interface ArtifactBundle {
  artifacts: ExportedArtifact[];
  manifest: ExportManifest;
}

export interface ArtifactBundleOptions {
  plannerRequest?: PlannerStartRequest;
  plannerResult?: PlannerResultSnapshot;
}

export function createArtifactBundle(project: CanonicalTsnProjectV0, options: ArtifactBundleOptions = {}): ArtifactBundle {
  const validation = validateCanonicalProject(project);

  if (!validation.ok) {
    throw new Error(`Cannot export invalid project: ${validation.errors.join("; ")}`);
  }

  const plannerInput = exportPlannerInput(project);
  const artifacts: ExportedArtifact[] = [
    {
      path: NED_CONTRACT.artifactPath,
      purpose: "simulation-inet",
      label: "INET/OMNeT++ 网络拓扑",
      content: exportNed(project),
    },
    {
      path: "simulation/inet/omnetpp.ini",
      purpose: "simulation-inet",
      label: "INET/OMNeT++ 入口配置",
      content: exportOmnetppIni(project),
    },
    {
      path: "simulation/inet/traffic.ini",
      purpose: "simulation-inet",
      label: "INET/OMNeT++ UDP 业务流配置",
      content: exportInetTrafficIni(project),
    },
    {
      path: "workspace/react-flow-topology.json",
      purpose: "workspace-visualization",
      label: "React Flow 拓扑展示数据",
      content: JSON.stringify(exportReactFlowTopology(project), null, 2),
    },
    {
      path: "planner/flow_plan_1.json",
      purpose: "planner-input",
      label: "规划器输入",
      content: JSON.stringify(plannerInput, null, 2),
    },
  ];

  if (options.plannerRequest) {
    artifacts.push({
      path: "planner/planner_request_1.json",
      purpose: "planner-request",
      label: "规划器请求快照",
      content: JSON.stringify(options.plannerRequest, null, 2),
    });
  }

  if (options.plannerResult) {
    const gcl = exportInetPlannerGcl(project, options.plannerResult);

    artifacts.push(
      {
        path: "planner/flow_plan_result_1.json",
        purpose: "planner-output",
        label: "规划器真实输出",
        observedExternal: true,
        content: JSON.stringify({
          plan_id: options.plannerResult.planId,
          state: options.plannerResult.state,
          source_outputs: options.plannerResult.sourceOutputs,
          output_fingerprints: options.plannerResult.outputFingerprints,
          trace_id: options.plannerResult.traceId,
          timestamp: options.plannerResult.timestamp,
          received_at: options.plannerResult.receivedAt,
          summary: options.plannerResult.summary,
        }, null, 2),
      },
      {
        path: "simulation/inet/planner-gcl.json",
        purpose: "planner-gcl",
        label: "INET GCL 追溯数据",
        content: gcl.json,
      },
      {
        path: "simulation/inet/planner-gcl-notes.md",
        purpose: "planner-gcl",
        label: "INET GCL 转换说明",
        content: gcl.notes,
      },
    );
  }

  const manifest: ExportManifest = {
    schemaVersion: "tsn-agent.export-manifest.v0",
    projectId: project.id,
    generatedAt: new Date().toISOString(),
    files: artifacts.map((artifact) => ({
      path: artifact.path,
      purpose: artifact.purpose,
      label: artifact.label,
      observedExternal: artifact.observedExternal,
    })),
  };

  return {
    artifacts: [
      ...artifacts,
      {
        path: "manifest.json",
        purpose: "manifest",
        label: "导出文件清单",
        content: JSON.stringify(manifest, null, 2),
      },
    ],
    manifest,
  };
}
