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
  tpl({
    id: "tpl-factory-linear",
    title: "线型拓扑",
    scenarioConfigId: "generic-tsn",
    sortOrder: 0,
  }),
  tpl({ id: "tpl-factory-star", title: "星型拓扑", scenarioConfigId: "generic-tsn", sortOrder: 1 }),
  tpl({
    id: "tpl-factory-dualplane",
    title: "双平面冗余拓扑",
    scenarioConfigId: "aerospace-onboard",
    sortOrder: 2,
  }),
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
  it("lists the three topology templates in one ungrouped row and snapshots separately", () => {
    setup();
    expect(screen.queryByText("航空航天")).not.toBeInTheDocument();
    expect(screen.queryByText("普通")).not.toBeInTheDocument();
    expect(screen.getByText("选择拓扑模板快速创建工程")).toBeInTheDocument();
    expect(screen.getByText("我的快捷模板")).toBeInTheDocument();
    const topologyCards = document.querySelector(".landing-template-cards");
    expect(topologyCards).toBeInTheDocument();
    expect(topologyCards?.querySelectorAll(".landing-card")).toHaveLength(3);
    expect(
      Array.from(topologyCards?.querySelectorAll(".landing-card-title") ?? []).map(
        (title) => title.textContent,
      ),
    ).toEqual(["双平面冗余拓扑", "线型拓扑", "星型拓扑"]);
    expect(screen.getByText("双平面冗余拓扑")).toBeInTheDocument();
    expect(screen.getByText("我的快照")).toBeInTheDocument();
  });

  it("shows each factory template topology preview and node-type counts without live-generation copy", () => {
    setup();
    expect(screen.queryByText(/现场生成/)).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "线型拓扑默认拓扑预览" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "星型拓扑默认拓扑预览" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "双平面冗余拓扑默认拓扑预览" })).toBeInTheDocument();

    const linearCard = screen.getByText("线型拓扑").closest(".landing-card") as HTMLElement;
    expect(within(linearCard).getByText("交换机 5")).toBeInTheDocument();
    expect(within(linearCard).getByText("端系统 2")).toBeInTheDocument();

    const starCard = screen.getByText("星型拓扑").closest(".landing-card") as HTMLElement;
    expect(within(starCard).getByText("交换机 1")).toBeInTheDocument();
    expect(within(starCard).getByText("端系统 4")).toBeInTheDocument();

    const dualPlaneCard = screen
      .getByText("双平面冗余拓扑")
      .closest(".landing-card") as HTMLElement;
    expect(within(dualPlaneCard).getByText("交换机 4")).toBeInTheDocument();
    expect(within(dualPlaneCard).getByText("端系统 4")).toBeInTheDocument();

    const dualPreview = within(dualPlaneCard).getByRole("img", {
      name: "双平面冗余拓扑默认拓扑预览",
    });
    expect(dualPreview.querySelector('[data-node-id="es-1"]')).toHaveAttribute(
      "transform",
      "translate(3 26.5)",
    );
    expect(dualPreview.querySelector('[data-node-id="sw-b1"]')).toHaveAttribute(
      "transform",
      "translate(27 26.5)",
    );
    expect(dualPreview.querySelector('[data-node-id="es-2"]')).toHaveAttribute(
      "transform",
      "translate(3 66.5)",
    );
    expect(dualPreview.querySelector('[data-node-id="sw-a1"]')).toHaveAttribute(
      "transform",
      "translate(27 66.5)",
    );
  });

  it("clicking a prompt card fires onUsePrompt; a snapshot card fires onUseSnapshot", () => {
    const props = setup();
    fireEvent.click(screen.getByText("线型拓扑"));
    expect(props.onUsePrompt).toHaveBeenCalledWith(
      expect.objectContaining({ id: "tpl-factory-linear" }),
    );
    fireEvent.click(screen.getByText("我的快照"));
    expect(props.onUseSnapshot).toHaveBeenCalledWith(expect.objectContaining({ id: "snap" }));
  });

  it("busy disables template cards (double-click guard)", () => {
    const props = setup({ busy: true });
    fireEvent.click(screen.getByText("线型拓扑"));
    expect(props.onUsePrompt).not.toHaveBeenCalled();
  });

  it("submits a manually entered topology requirement", () => {
    const props = setup();
    expect(screen.queryByRole("button", { name: "通用 TSN" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "航空航天 TSN 典型场景" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "描述你的 TSN 需求" }), {
      target: { value: "4 个交换机 5 个端系统" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送需求" }));
    expect(props.onSubmitIntent).toHaveBeenCalledWith("4 个交换机 5 个端系统");
  });

  it("factory topology cards hide management actions; snapshot delete remains available", () => {
    const props = setup();
    const starCard = screen.getByText("星型拓扑").closest(".landing-card") as HTMLElement;
    expect(within(starCard).queryByRole("button", { name: "上移" })).not.toBeInTheDocument();
    expect(within(starCard).queryByRole("button", { name: "下移" })).not.toBeInTheDocument();
    expect(within(starCard).queryByRole("button", { name: "删除模板" })).not.toBeInTheDocument();

    const snapshotCard = screen.getByText("我的快照").closest(".landing-card") as HTMLElement;
    fireEvent.click(within(snapshotCard).getByRole("button", { name: "删除模板" }));
    expect(props.onDeleteTemplate).toHaveBeenCalledWith(expect.objectContaining({ id: "snap" }));
  });

  it("shows guidance when no snapshot templates exist", () => {
    setup({ templates: TEMPLATES.filter((t) => t.kind === "prompt") });
    expect(screen.getByText(/还没有快捷模板/)).toBeInTheDocument();
  });
});
