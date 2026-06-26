import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TimeSyncPanel, type TimeSyncPanelProps } from "./time-sync-panel";
import type { SimResult } from "./timesync-sim";

function convergedResult(): SimResult {
  return {
    caliber: "timesync_simulated",
    status: "converged",
    overall: "2 个从节点全部收敛",
    perNode: [
      {
        mid: "TsnAgentTimesyncNetwork.sw1.clock",
        maxOffsetNs: 12.3,
        meanOffsetNs: 5.1,
        converged: true,
        withinThreshold: true,
        samples: [
          { tMs: 0, offsetNs: 12.3 },
          { tMs: 500, offsetNs: 2.1 },
          { tMs: 1000, offsetNs: 0.4 },
        ],
      },
      {
        mid: "TsnAgentTimesyncNetwork.es2.clock",
        maxOffsetNs: 30.7,
        meanOffsetNs: 9.9,
        converged: true,
        withinThreshold: true,
        samples: [
          { tMs: 0, offsetNs: -30.7 },
          { tMs: 500, offsetNs: -4.0 },
          { tMs: 1000, offsetNs: 0.9 },
        ],
      },
    ],
  };
}

function partlyConvergedResult(): SimResult {
  return {
    caliber: "timesync_simulated",
    status: "converged",
    overall: "1 个收敛 / 1 个未收敛",
    perNode: [
      {
        mid: "1",
        maxOffsetNs: 12.3,
        meanOffsetNs: 5.1,
        converged: true,
        withinThreshold: true,
        samples: [{ tMs: 0, offsetNs: 12.3 }],
      },
      {
        mid: "2",
        maxOffsetNs: 9000,
        meanOffsetNs: 8000,
        converged: false,
        withinThreshold: false,
        samples: [{ tMs: 0, offsetNs: 9000 }],
      },
    ],
  };
}

function emptyResult(): SimResult {
  return {
    caliber: "timesync_simulated",
    status: "empty",
    overall: "结果为空：未取到 timeChanged 向量",
    perNode: [],
    message: "0 行 timeChanged，请检查 recording/模块路径。",
  };
}

function baseProps(overrides: Partial<TimeSyncPanelProps> = {}): TimeSyncPanelProps {
  return {
    inTimeSyncStage: true,
    treeConfirmed: true,
    sessionId: "s1",
    simState: { status: "idle" },
    onSimStateChange: vi.fn(),
    runTimesyncSim: vi.fn(async () => convergedResult()),
    explainSim: vi.fn(async () => "解释内容"),
    ...overrides,
  };
}

describe("TimeSyncPanel 门控（U11）", () => {
  it("非 time-sync 阶段 → 软仿 disabled + 「请先进入时钟同步阶段」", () => {
    render(<TimeSyncPanel {...baseProps({ inTimeSyncStage: false })} />);
    const button = screen.getByRole("button", { name: "软仿" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "请先进入时钟同步阶段");
  });

  it("阶段对但树未确认 → disabled + 「请先确认时钟树」（区别文案）", () => {
    render(<TimeSyncPanel {...baseProps({ treeConfirmed: false })} />);
    const button = screen.getByRole("button", { name: "软仿" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "请先确认时钟树");
  });

  it("阶段对且树已确认 → 软仿可点", () => {
    render(<TimeSyncPanel {...baseProps()} />);
    expect(screen.getByRole("button", { name: "软仿" })).toBeEnabled();
  });
});

describe("TimeSyncPanel 运行/结果（U11）", () => {
  it("初始态显示引导文案", () => {
    render(<TimeSyncPanel {...baseProps()} />);
    expect(screen.getByText("点软仿运行后在此查看")).toBeInTheDocument();
  });

  it("点软仿 → invoke 命令、置运行态", async () => {
    const user = userEvent.setup();
    const runTimesyncSim = vi.fn(async () => convergedResult());
    const onSimStateChange = vi.fn();
    render(<TimeSyncPanel {...baseProps({ runTimesyncSim, onSimStateChange })} />);
    await user.click(screen.getByRole("button", { name: "软仿" }));
    await waitFor(() => expect(runTimesyncSim).toHaveBeenCalledWith("s1", {}));
    expect(onSimStateChange).toHaveBeenCalledWith({ status: "running" });
    expect(onSimStateChange).toHaveBeenCalledWith({
      status: "done",
      result: convergedResult(),
    });
  });

  it("运行中态显示「仿真进行中…」、软仿按钮 loading", () => {
    render(<TimeSyncPanel {...baseProps({ simState: { status: "running" } })} />);
    expect(screen.getByText("仿真进行中…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "软仿运行中…" })).toBeDisabled();
  });

  it("收敛结果渲染汇总表（每从节点一行 + 收敛徽标 + 总判定）", () => {
    render(
      <TimeSyncPanel {...baseProps({ simState: { status: "done", result: convergedResult() } })} />,
    );
    expect(screen.getByLabelText("软仿总判定")).toHaveTextContent("2 个从节点全部收敛");
    const table = screen.getByRole("table");
    expect(within(table).getAllByText("收敛", { selector: ".sim-badge" })).toHaveLength(2);
    expect(within(table).getByText("12.3 ns")).toBeInTheDocument();
  });

  it("收敛结果在表下渲染抖动曲线（每从节点一条线 + 阈值带 + 短名图例）", () => {
    render(
      <TimeSyncPanel {...baseProps({ simState: { status: "done", result: convergedResult() } })} />,
    );
    const chart = screen.getByRole("img", { name: "从节点偏差随仿真时间抖动曲线" });
    expect(chart).toBeInTheDocument();
    expect(chart.querySelectorAll("polyline.sim-chart-line")).toHaveLength(2);
    // ±1µs 收敛阈值带。
    expect(chart.querySelector("rect.sim-chart-threshold-band")).not.toBeNull();
    // 图例与表格用短名（sw1/es2，各出现在表格+图例），完整模块路径只放 title 不进文本。
    expect(screen.getAllByText("sw1").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("es2").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("TsnAgentTimesyncNetwork.sw1.clock")).not.toBeInTheDocument();
  });

  it("空结果不渲染全绿（显示 message、无表格）", () => {
    render(
      <TimeSyncPanel {...baseProps({ simState: { status: "done", result: emptyResult() } })} />,
    );
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByLabelText("软仿总判定")).toHaveClass("warn");
    expect(screen.getByText(/0 行 timeChanged/)).toBeInTheDocument();
  });

  it("硬仿点击 → 占位提示", async () => {
    const user = userEvent.setup();
    render(<TimeSyncPanel {...baseProps()} />);
    await user.click(screen.getByRole("button", { name: "硬仿" }));
    expect(screen.getByText("待接入真实硬件")).toBeInTheDocument();
  });
});

describe("TimeSyncPanel 覆盖表单（U12）", () => {
  it("默认收起；展开后填值随软仿命令提交", async () => {
    const user = userEvent.setup();
    const runTimesyncSim = vi.fn(async () => convergedResult());
    render(<TimeSyncPanel {...baseProps({ runTimesyncSim })} />);
    expect(screen.queryByLabelText("软仿覆盖参数")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /覆盖参数/ }));
    fireEvent.change(screen.getByLabelText("振荡器类型"), { target: { value: "Random" } });
    fireEvent.change(screen.getByLabelText("漂移幅度（ppm）"), { target: { value: "200" } });
    fireEvent.change(screen.getByLabelText("仿真时长（s）"), { target: { value: "5" } });

    await user.click(screen.getByRole("button", { name: "软仿" }));
    await waitFor(() =>
      expect(runTimesyncSim).toHaveBeenCalledWith("s1", {
        oscillator: "Random",
        driftPpm: 200,
        simTimeS: 5,
      }),
    );
  });

  it("不填 → 提交空覆盖（走后端默认）", async () => {
    const user = userEvent.setup();
    const runTimesyncSim = vi.fn(async () => convergedResult());
    render(<TimeSyncPanel {...baseProps({ runTimesyncSim })} />);
    await user.click(screen.getByRole("button", { name: "软仿" }));
    await waitFor(() => expect(runTimesyncSim).toHaveBeenCalledWith("s1", {}));
  });
});

describe("TimeSyncPanel 解释（U13）", () => {
  it("有未收敛 → 「解释」可见；点击发汇总并渲染说明", async () => {
    const user = userEvent.setup();
    const explainSim = vi.fn(async (_prompt: string) => "未收敛可能因为漂移过大");
    render(
      <TimeSyncPanel
        {...baseProps({
          simState: { status: "done", result: partlyConvergedResult() },
          explainSim,
        })}
      />,
    );
    await user.click(screen.getByRole("button", { name: "解释" }));
    await waitFor(() => expect(explainSim).toHaveBeenCalled());
    expect(String(explainSim.mock.calls[0]?.[0])).toContain("时钟同步阶段");
    expect(screen.getByLabelText("软仿解释")).toHaveTextContent("未收敛可能因为漂移过大");
    expect(screen.getByRole("button", { name: "重新解释" })).toBeInTheDocument();
  });

  it("全收敛 → 无「解释」按钮", () => {
    render(
      <TimeSyncPanel {...baseProps({ simState: { status: "done", result: convergedResult() } })} />,
    );
    expect(screen.queryByRole("button", { name: "解释" })).not.toBeInTheDocument();
  });

  it("解释失败 → 「解释生成失败，可重试」并恢复按钮", async () => {
    const user = userEvent.setup();
    const explainSim = vi.fn(async () => {
      throw new Error("boom");
    });
    render(
      <TimeSyncPanel
        {...baseProps({
          simState: { status: "done", result: partlyConvergedResult() },
          explainSim,
        })}
      />,
    );
    await user.click(screen.getByRole("button", { name: "解释" }));
    await waitFor(() => expect(screen.getByText("解释生成失败，可重试")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "解释" })).toBeEnabled();
  });
});

/** 受控 deferred：手动控制 promise 何时 resolve，模拟 await 期间的会话切换/并发。 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("TimeSyncPanel 异步竞态", () => {
  it("软仿运行中切走会话 → 迟到结果不落进新会话", async () => {
    const user = userEvent.setup();
    const pending = deferred<SimResult>();
    const runTimesyncSim = vi.fn(() => pending.promise);
    const onSimStateChange = vi.fn();
    const { rerender } = render(
      <TimeSyncPanel {...baseProps({ sessionId: "s1", runTimesyncSim, onSimStateChange })} />,
    );

    await user.click(screen.getByRole("button", { name: "软仿" }));
    expect(onSimStateChange).toHaveBeenCalledWith({ status: "running" });

    // await 未结束前切到新会话（prop 变化）。
    rerender(
      <TimeSyncPanel {...baseProps({ sessionId: "s2", runTimesyncSim, onSimStateChange })} />,
    );

    pending.resolve(convergedResult());
    await pending.promise;

    // 切走后 done 不得落进新会话状态。
    expect(onSimStateChange).not.toHaveBeenCalledWith({
      status: "done",
      result: convergedResult(),
    });
  });

  it("软仿快速双击 → invoke 只调用一次", async () => {
    const pending = deferred<SimResult>();
    const runTimesyncSim = vi.fn(() => pending.promise);
    render(<TimeSyncPanel {...baseProps({ runTimesyncSim })} />);

    const button = screen.getByRole("button", { name: "软仿" });
    // 两次同步点击，disabled 态下一拍才生效；ref 守卫拦住第二次。
    fireEvent.click(button);
    fireEvent.click(button);

    expect(runTimesyncSim).toHaveBeenCalledTimes(1);
    pending.resolve(convergedResult());
    await pending.promise;
  });

  it("解释快速双击 → LLM 只调用一次", async () => {
    const pending = deferred<string>();
    const explainSim = vi.fn(() => pending.promise);
    render(
      <TimeSyncPanel
        {...baseProps({
          simState: { status: "done", result: partlyConvergedResult() },
          explainSim,
        })}
      />,
    );

    const button = screen.getByRole("button", { name: "解释" });
    fireEvent.click(button);
    fireEvent.click(button);

    expect(explainSim).toHaveBeenCalledTimes(1);
    pending.resolve("解释内容");
    await pending.promise;
  });
});
