import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserTemplateService, createTemplateService } from "./template-service";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

describe("template service (browser fallback)", () => {
  it("returns empty list and throws on writes outside Tauri", async () => {
    const service = createBrowserTemplateService();
    await expect(service.listTemplates()).resolves.toEqual([]);
    await expect(service.deleteTemplate("x")).rejects.toThrow("桌面应用");
    await expect(service.applySnapshotTemplate("t", "s")).rejects.toThrow("桌面应用");
  });
});

describe("template service (Tauri invoke)", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  });

  it("invokes each command with the expected name and args", async () => {
    invokeMock.mockResolvedValue(undefined);
    const service = createTemplateService();

    await service.listTemplates();
    await service.deleteTemplate("tpl-1");
    await service.reorderTemplates(["a", "b"]);
    await service.createSnapshotTemplate({
      sessionId: "s1",
      title: "T",
      scenarioConfigId: "aerospace-onboard",
    });
    invokeMock.mockResolvedValueOnce({ scenarioConfigId: "generic-tsn", mutationId: 7 });
    await service.applySnapshotTemplate("tpl-2", "s2");

    expect(invokeMock).toHaveBeenNthCalledWith(1, "list_project_templates");
    expect(invokeMock).toHaveBeenNthCalledWith(2, "delete_project_template", { id: "tpl-1" });
    expect(invokeMock).toHaveBeenNthCalledWith(3, "reorder_project_templates", {
      orderedIds: ["a", "b"],
    });
    expect(invokeMock).toHaveBeenNthCalledWith(4, "create_snapshot_template", {
      request: { sessionId: "s1", title: "T", scenarioConfigId: "aerospace-onboard" },
    });
    expect(invokeMock).toHaveBeenNthCalledWith(5, "use_snapshot_template", {
      request: { templateId: "tpl-2", sessionId: "s2" },
    });

    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });
});
