import { describe, expect, it, vi } from "vitest";
import { createBrowserSkillFileService, createSkillFileService } from "./skill-file-service";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

describe("skill file service", () => {
  it("returns unavailable browser fallback outside Tauri", async () => {
    const service = createBrowserSkillFileService();

    await expect(service.listFiles("tsn-topology")).resolves.toMatchObject({
      skillId: "tsn-topology",
      status: "unavailable",
      files: [],
    });
    await expect(service.readFile("tsn-topology", "SKILL.md")).rejects.toThrow("桌面应用");
    await expect(service.describeTopologyTemplates()).rejects.toThrow("桌面应用");
  });

  it("invokes Tauri commands with skill id and relative path only", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    invokeMock.mockResolvedValueOnce({
      skillId: "tsn-topology",
      status: "available",
      files: [],
    });
    invokeMock.mockResolvedValueOnce({
      skillId: "tsn-topology",
      path: "SKILL.md",
      content: "content",
      editable: true,
    });
    invokeMock.mockResolvedValueOnce({
      skillId: "tsn-topology",
      path: "SKILL.md",
      content: "updated",
      editable: true,
    });
    invokeMock.mockResolvedValueOnce({
      templateCount: 3,
      templateIds: ["generic-line", "generic-ring", "dual-plane-redundant"],
      templates: [],
    });

    const service = createSkillFileService();

    await service.listFiles("tsn-topology");
    await service.readFile("tsn-topology", "SKILL.md");
    await service.writeFile("tsn-topology", "SKILL.md", "updated");
    await service.describeTopologyTemplates();

    expect(invokeMock).toHaveBeenNthCalledWith(1, "list_skill_files", {
      request: { skillId: "tsn-topology" },
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "read_skill_file", {
      request: { skillId: "tsn-topology", path: "SKILL.md" },
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, "write_skill_file", {
      request: { skillId: "tsn-topology", path: "SKILL.md", content: "updated" },
    });
    expect(invokeMock).toHaveBeenNthCalledWith(4, "describe_topology_templates");

    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });
});
