import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SkillFileService } from "../../skills/skill-file-service";
import { SkillFilePreview } from "./SkillFilePreview";

function createService(overrides: Partial<SkillFileService> = {}): SkillFileService {
  return {
    listFiles: vi.fn().mockResolvedValue({
      skillId: "tsn-topology",
      status: "available",
      files: [
        {
          path: "SKILL.md",
          kind: "file",
          sizeBytes: 24,
          canPreview: true,
          canEdit: true,
        },
        {
          path: "tools/binary.bin",
          kind: "file",
          sizeBytes: 4,
          canPreview: false,
          canEdit: false,
          reason: "非 UTF-8 文本文件不可预览。",
        },
      ],
    }),
    readFile: vi.fn().mockResolvedValue({
      skillId: "tsn-topology",
      path: "SKILL.md",
      content: "原始 skill 内容",
      editable: true,
    }),
    writeFile: vi.fn().mockImplementation(async (_skillId, path, content) => ({
      skillId: "tsn-topology",
      path,
      content,
      editable: true,
    })),
    describeTopologyTemplates: vi.fn().mockResolvedValue({
      templateCount: 3,
      templateIds: ["generic-line", "generic-ring", "dual-plane-redundant"],
      templates: [],
    }),
    ...overrides,
  };
}

describe("SkillFilePreview", () => {
  it("lists skill files and previews SKILL.md by default", async () => {
    const service = createService();

    render(<SkillFilePreview skillId="tsn-topology" service={service} />);

    expect(await screen.findByRole("button", { name: /SKILL.md/ })).toBeInTheDocument();
    expect(await screen.findByText("原始 skill 内容")).toBeInTheDocument();
    expect(service.listFiles).toHaveBeenCalledWith("tsn-topology");
    expect(service.readFile).toHaveBeenCalledWith("tsn-topology", "SKILL.md");
  });

  it("edits and saves small text files", async () => {
    const user = userEvent.setup();
    const service = createService();

    render(<SkillFilePreview skillId="tsn-topology" service={service} />);

    await screen.findByText("原始 skill 内容");
    await user.click(screen.getByRole("button", { name: "编辑文件" }));
    await user.clear(screen.getByLabelText("Skill 文件内容"));
    await user.type(screen.getByLabelText("Skill 文件内容"), "更新后的内容");
    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(service.writeFile).toHaveBeenCalledWith("tsn-topology", "SKILL.md", "更新后的内容");
    });
    expect(await screen.findByText("更新后的内容")).toBeInTheDocument();
  });

  it("keeps draft content when save fails", async () => {
    const user = userEvent.setup();
    const service = createService({
      writeFile: vi.fn().mockRejectedValue(new Error("保存失败")),
    });

    render(<SkillFilePreview skillId="tsn-topology" service={service} />);

    await screen.findByText("原始 skill 内容");
    await user.click(screen.getByRole("button", { name: "编辑文件" }));
    await user.clear(screen.getByLabelText("Skill 文件内容"));
    await user.type(screen.getByLabelText("Skill 文件内容"), "未保存内容");
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByText("保存失败")).toBeInTheDocument();
    expect(screen.getByDisplayValue("未保存内容")).toBeInTheDocument();
  });

  it("shows unavailable state when a skill has no file directory", async () => {
    const service = createService({
      listFiles: vi.fn().mockResolvedValue({
        skillId: "tsn-time-sync",
        status: "unavailable",
        files: [],
        message: "暂无可预览的 skill 文件目录。",
      }),
    });

    render(<SkillFilePreview skillId="tsn-time-sync" service={service} />);

    expect(await screen.findByText("暂无可预览的 skill 文件目录。")).toBeInTheDocument();
    expect(screen.getByText("暂无目录")).toBeInTheDocument();
  });

  it("shows readonly factory notice instead of a disabled editor", async () => {
    const service = createService({
      readFile: vi.fn().mockResolvedValue({
        skillId: "tsn-topology",
        path: "SKILL.md",
        content: "只读内容",
        editable: false,
        readonlyReason: "只读 skill 资源不可编辑。",
      }),
    });

    render(<SkillFilePreview skillId="tsn-topology" service={service} />);

    expect(await screen.findByText("只读内容")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "编辑文件" })).not.toBeInTheDocument();
    expect(screen.getByText(/出厂只读指引/)).toBeInTheDocument();
    expect(screen.getByText(/只读 skill 资源不可编辑/)).toBeInTheDocument();
  });

  it("renders the topology legal-domain from the catalog", async () => {
    const service = createService({
      describeTopologyTemplates: vi.fn().mockResolvedValue({
        templateCount: 1,
        templateIds: ["generic-line"],
        templates: [
          {
            id: "generic-line",
            name: "通用线型拓扑",
            params: [
              { name: "switchCount", type: "integer", minimum: 1, maximum: 12 },
              { name: "dataRateMbps", type: "enum", values: [10, 100, 1000, 10000] },
            ],
          },
        ],
      }),
    });

    render(<SkillFilePreview skillId="tsn-topology" service={service} />);

    expect(await screen.findByRole("region", { name: "参数合法域" })).toBeInTheDocument();
    expect(await screen.findByText("switchCount")).toBeInTheDocument();
    expect(screen.getByText("dataRateMbps")).toBeInTheDocument();
  });

  it("shows legal-domain unavailable when the catalog command fails", async () => {
    const service = createService({
      describeTopologyTemplates: vi.fn().mockRejectedValue(new Error("命令不可用")),
    });

    render(<SkillFilePreview skillId="tsn-topology" service={service} />);

    expect(await screen.findByText(/参数合法域当前不可用/)).toBeInTheDocument();
  });

  it("hints when the SKILL.md guidance is empty", async () => {
    const service = createService({
      readFile: vi.fn().mockResolvedValue({
        skillId: "tsn-topology",
        path: "SKILL.md",
        content: "",
        editable: true,
      }),
    });

    render(<SkillFilePreview skillId="tsn-topology" service={service} />);

    expect(await screen.findByText(/清空将使 agent 失去领域指引/)).toBeInTheDocument();
  });

  it("does not render the legal-domain section for non-topology skills", async () => {
    const service = createService({
      listFiles: vi.fn().mockResolvedValue({
        skillId: "tsn-flow-planning",
        status: "available",
        files: [{ path: "SKILL.md", kind: "file", sizeBytes: 10, canPreview: true, canEdit: true }],
      }),
      readFile: vi.fn().mockResolvedValue({
        skillId: "tsn-flow-planning",
        path: "SKILL.md",
        content: "flow 内容",
        editable: true,
      }),
    });

    render(<SkillFilePreview skillId="tsn-flow-planning" service={service} />);

    expect(await screen.findByText("flow 内容")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "参数合法域" })).not.toBeInTheDocument();
    expect(service.describeTopologyTemplates).not.toHaveBeenCalled();
  });
});
