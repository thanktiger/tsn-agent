import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TemplateRow } from "../../../templates/template-service";
import { LandingPage, type LandingPageProps } from "./LandingPage";

function tpl(over: Partial<TemplateRow> & Pick<TemplateRow, "id">): TemplateRow {
  return {
    id: over.id,
    kind: over.kind ?? "prompt",
    scenarioConfigId: over.scenarioConfigId ?? "generic-tsn",
    title: over.title ?? over.id,
    subtitle: over.subtitle ?? null,
    promptText: over.promptText ?? "建个网络",
    sortOrder: over.sortOrder ?? 0,
    origin: over.origin ?? "factory",
  };
}

const TEMPLATES: TemplateRow[] = [
  tpl({ id: "dual", title: "双平面冗余拓扑", scenarioConfigId: "aerospace-onboard", sortOrder: 0 }),
  tpl({ id: "linear", title: "线型拓扑", scenarioConfigId: "generic-tsn", sortOrder: 1 }),
  tpl({ id: "star", title: "星型拓扑", scenarioConfigId: "generic-tsn", sortOrder: 2 }),
  tpl({
    id: "snap",
    kind: "snapshot",
    title: "我的快照",
    origin: "user",
    promptText: null,
    sortOrder: 3,
  }),
];

function setup(over: Partial<LandingPageProps> = {}) {
  const props: LandingPageProps = {
    templates: TEMPLATES,
    examples: [{ id: "ex1", label: "通用 TSN", intent: "4 个交换机 5 个端系统" }],
    busy: false,
    onSubmitIntent: vi.fn(),
    onUsePrompt: vi.fn(),
    onUseSnapshot: vi.fn(),
    onDeleteTemplate: vi.fn(),
    onReorder: vi.fn(),
    ...over,
  };
  render(<LandingPage {...props} />);
  return props;
}

describe("LandingPage", () => {
  it("groups prompt cards by scenario-derived category and lists snapshots separately (AE5)", () => {
    setup();
    expect(screen.getByText("航空航天")).toBeInTheDocument();
    expect(screen.getByText("普通")).toBeInTheDocument();
    expect(screen.getByText("我的快捷模板")).toBeInTheDocument();
    // 双平面在航空航天组、快照在快捷区。
    expect(screen.getByText("双平面冗余拓扑")).toBeInTheDocument();
    expect(screen.getByText("我的快照")).toBeInTheDocument();
  });

  it("clicking a prompt card fires onUsePrompt; a snapshot card fires onUseSnapshot", () => {
    const props = setup();
    fireEvent.click(screen.getByText("线型拓扑"));
    expect(props.onUsePrompt).toHaveBeenCalledWith(expect.objectContaining({ id: "linear" }));
    fireEvent.click(screen.getByText("我的快照"));
    expect(props.onUseSnapshot).toHaveBeenCalledWith(expect.objectContaining({ id: "snap" }));
  });

  it("busy disables template cards (double-click guard)", () => {
    const props = setup({ busy: true });
    fireEvent.click(screen.getByText("线型拓扑"));
    expect(props.onUsePrompt).not.toHaveBeenCalled();
  });

  it("example chip fills the input, then send submits it", () => {
    const props = setup();
    fireEvent.click(screen.getByRole("button", { name: "通用 TSN" }));
    fireEvent.click(screen.getByRole("button", { name: "发送需求" }));
    expect(props.onSubmitIntent).toHaveBeenCalledWith("4 个交换机 5 个端系统");
  });

  it("delete button fires onDeleteTemplate", () => {
    const props = setup();
    const starCard = screen.getByText("星型拓扑").closest(".landing-card") as HTMLElement;
    fireEvent.click(within(starCard).getByRole("button", { name: "删除模板" }));
    expect(props.onDeleteTemplate).toHaveBeenCalledWith(expect.objectContaining({ id: "star" }));
  });

  it("reorder up on star swaps with linear in the full order", () => {
    const props = setup();
    const starCard = screen.getByText("星型拓扑").closest(".landing-card") as HTMLElement;
    fireEvent.click(within(starCard).getByRole("button", { name: "上移" }));
    // 全量序 [dual, linear, star, snap] → star 与同组前邻 linear 交换 → [dual, star, linear, snap]
    expect(props.onReorder).toHaveBeenCalledWith(["dual", "star", "linear", "snap"]);
  });

  it("shows guidance when no snapshot templates exist", () => {
    setup({ templates: TEMPLATES.filter((t) => t.kind === "prompt") });
    expect(screen.getByText(/还没有快捷模板/)).toBeInTheDocument();
  });
});
