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
    restoreFactorySkills: vi.fn().mockImplementation(async (dryRun: boolean) => ({
      dryRun,
      restored: ["tsn-topology/SKILL.md"],
      removed: ["tsn-topology/package.json"],
      preserved: ["tsn-topology/my-notes.md"],
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
    // 可编辑（available）状态不渲染只读提示条。
    expect(screen.queryByText(/当前为只读指引/)).not.toBeInTheDocument();
  });

  it("hides HTML/markdown comments in the rendered SKILL.md preview", async () => {
    const service = createService({
      readFile: vi.fn().mockResolvedValue({
        skillId: "tsn-topology",
        path: "SKILL.md",
        content: "<!-- 消费方式：维护者元注释 -->\n\n# 主索引标题\n\n正文可见内容",
        editable: true,
      }),
    });

    render(<SkillFilePreview skillId="tsn-topology" service={service} />);

    // 正文与标题正常渲染。
    expect(await screen.findByText("正文可见内容")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "主索引标题" })).toBeInTheDocument();
    // 注释及其 <!-- --> 标记不在渲染视图里露出。
    expect(screen.queryByText(/维护者元注释/)).not.toBeInTheDocument();
    const rendered = document.querySelector(".skill-file-markdown")?.textContent ?? "";
    expect(rendered).not.toContain("<!--");
    expect(rendered).not.toContain("-->");
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

  it("shows readonly fallback notice instead of a disabled editor", async () => {
    const service = createService({
      readFile: vi.fn().mockResolvedValue({
        skillId: "tsn-topology",
        path: "SKILL.md",
        content: "只读内容",
        editable: false,
        readonlyReason: "可写 skill 副本不可用（无法创建可写目录），当前为内置只读副本。",
      }),
    });

    render(<SkillFilePreview skillId="tsn-topology" service={service} />);

    expect(await screen.findByText("只读内容")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "编辑文件" })).not.toBeInTheDocument();
    expect(screen.getByText(/当前为只读指引/)).toBeInTheDocument();
    expect(screen.getByText(/可写 skill 副本不可用/)).toBeInTheDocument();
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

  it("restores factory skills via dry-run preview and inline confirmation", async () => {
    const user = userEvent.setup();
    const service = createService();

    render(<SkillFilePreview skillId="tsn-topology" service={service} />);

    await screen.findByText("原始 skill 内容");
    await user.click(screen.getByRole("button", { name: /恢复内置版本/ }));

    // dry-run 清单内联确认：恢复/删除/自建三段。
    const dialog = await screen.findByRole("alertdialog", { name: "恢复内置版本确认" });
    expect(service.restoreFactorySkills).toHaveBeenCalledWith(true);
    expect(dialog).toHaveTextContent("恢复 1 个文件：tsn-topology/SKILL.md");
    expect(dialog).toHaveTextContent("删除 1 个出厂已移除文件：tsn-topology/package.json");
    expect(dialog).toHaveTextContent("自建文件不受影响：tsn-topology/my-notes.md");

    await user.click(screen.getByRole("button", { name: "确认恢复" }));

    await waitFor(() => {
      expect(service.restoreFactorySkills).toHaveBeenCalledWith(false);
    });
    expect(await screen.findByText(/已恢复内置版本（恢复 1 个、删除 1 个文件）/)).toBeInTheDocument();
    // 恢复后刷新文件列表（初次加载 + 恢复后各一次）。
    await waitFor(() => {
      expect(service.listFiles).toHaveBeenCalledTimes(2);
    });
  });

  it("disables confirmation when the dry-run plan is empty", async () => {
    const user = userEvent.setup();
    const service = createService({
      restoreFactorySkills: vi.fn().mockResolvedValue({
        dryRun: true,
        restored: [],
        removed: [],
        preserved: [],
      }),
    });

    render(<SkillFilePreview skillId="tsn-topology" service={service} />);
    await screen.findByText("原始 skill 内容");
    await user.click(screen.getByRole("button", { name: /恢复内置版本/ }));

    const dialog = await screen.findByRole("alertdialog", { name: "恢复内置版本确认" });
    expect(dialog).toHaveTextContent("没有需要恢复的文件（已与内置版本一致）");
    expect(screen.getByRole("button", { name: "确认恢复" })).toBeDisabled();
    // 确认按钮禁用：不会触发 dryRun=false 的二次调用。
    expect(service.restoreFactorySkills).toHaveBeenCalledTimes(1);
    expect(service.restoreFactorySkills).toHaveBeenCalledWith(true);
  });

  it("locks file editing while the restore confirmation is open", async () => {
    const user = userEvent.setup();
    const service = createService();

    render(<SkillFilePreview skillId="tsn-topology" service={service} />);
    await screen.findByText("原始 skill 内容");
    await user.click(screen.getByRole("button", { name: /恢复内置版本/ }));
    await screen.findByRole("alertdialog", { name: "恢复内置版本确认" });

    // 确认窗口期编辑入口禁用（防确认清单与实际恢复集合漂移）。
    expect(screen.getByRole("button", { name: "编辑文件" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.getByRole("button", { name: "编辑文件" })).toBeEnabled();
  });

  it("cancels the restore confirmation without touching disk", async () => {
    const user = userEvent.setup();
    const service = createService();

    render(<SkillFilePreview skillId="tsn-topology" service={service} />);

    await screen.findByText("原始 skill 内容");
    await user.click(screen.getByRole("button", { name: /恢复内置版本/ }));
    await screen.findByRole("alertdialog", { name: "恢复内置版本确认" });
    await user.click(screen.getByRole("button", { name: "取消" }));

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(service.restoreFactorySkills).toHaveBeenCalledTimes(1);
    expect(service.restoreFactorySkills).toHaveBeenCalledWith(true);
  });

  it("surfaces restore errors and disables restore on readonly roots", async () => {
    const user = userEvent.setup();
    const failing = createService({
      restoreFactorySkills: vi.fn().mockRejectedValue(new Error("内置 skill 资源不可用，无法恢复内置版本。")),
    });

    render(<SkillFilePreview skillId="tsn-topology" service={failing} />);
    await screen.findByText("原始 skill 内容");
    await user.click(screen.getByRole("button", { name: /恢复内置版本/ }));
    expect(await screen.findByText(/内置 skill 资源不可用/)).toBeInTheDocument();

    // 只读根（播种失败回退）下按钮禁用。
    const readonly = createService({
      listFiles: vi.fn().mockResolvedValue({
        skillId: "tsn-topology",
        status: "readonly",
        files: [{ path: "SKILL.md", kind: "file", sizeBytes: 10, canPreview: true, canEdit: false }],
      }),
    });
    render(<SkillFilePreview skillId="tsn-topology" service={readonly} />);
    await waitFor(() => {
      const buttons = screen.getAllByRole("button", { name: /恢复内置版本/ });
      expect(buttons[buttons.length - 1]).toBeDisabled();
    });
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
