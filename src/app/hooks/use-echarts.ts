import type * as ECharts from "echarts";
import { type RefObject, useEffect, useRef } from "react";

/** `useEChartsOption` 配置。 */
export interface UseEChartsOptionConfig {
  /** console.error 前缀标签（排查空白画布时区分组件）。 */
  logTag: string;
  /** init 完成、首次 setOption 之前回调（注册事件 / 存实例引用等）；
   * 返回的清理函数在 dispose 前调用（无需清理返回 undefined）。 */
  onInit?: (chart: ECharts.ECharts) => (() => void) | undefined;
}

/**
 * ECharts 生命周期共享 hook（gantt / flow-chain / time-sync 三画布同型块收敛）：
 * 动态 import（保持代码分包）→ init → setOption(notMerge) → resize + ResizeObserver，
 * option 变化增量 setOption，卸载 dispose。
 *
 * 踩坑固化（原三处组件内注释合并）：
 * - import 是异步的——StrictMode 双挂载 / HMR 会在 import 解析前就 cleanup，disposed
 *   标志位 + 容器比对后直接退出不 init；
 * - 同一 dom 重复 init 时 echarts 会返回旧实例并告警，随后前一个 effect 的 cleanup 把
 *   这个共享实例 dispose 掉 → setOption 打在已 disposed 的实例上 → 空白画布。先清残留
 *   实例确保每次都拿到全新实例；cleanup 只 dispose 本 effect 自己的 chart（局部变量）；
 * - init 可能在容器完成布局前读到 0 宽/高（Tauri WebKit 时序）——立即 resize 读真实
 *   尺寸，并用 ResizeObserver 盯容器本身（弹窗/分栏布局变化不触发 window resize）；
 * - catch 把被 promise 吞掉的 echarts import/init/setOption 报错暴露出来。
 */
export function useEChartsOption(
  containerRef: RefObject<HTMLDivElement | null>,
  option: ECharts.EChartsOption,
  config: UseEChartsOptionConfig,
): void {
  const chartInstanceRef = useRef<ECharts.ECharts | undefined>(undefined);
  const latestOptionRef = useRef(option);
  // config 每次渲染都是新对象字面量——走 ref 取最新值，不进挂载 effect 依赖。
  const configRef = useRef(config);
  configRef.current = config;

  useEffect(() => {
    latestOptionRef.current = option;
    chartInstanceRef.current?.setOption(option, { notMerge: true, lazyUpdate: true });
  }, [option]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) {
      return undefined;
    }
    let disposed = false;
    let chart: ECharts.ECharts | undefined;
    let observer: ResizeObserver | undefined;
    let cleanupInit: (() => void) | undefined;

    void import("echarts")
      .then((echarts) => {
        if (disposed || containerRef.current !== el) {
          return;
        }
        echarts.getInstanceByDom(el)?.dispose();
        chart = echarts.init(el, undefined, { renderer: "canvas" });
        chartInstanceRef.current = chart;
        cleanupInit = configRef.current.onInit?.(chart);
        chart.setOption(latestOptionRef.current, { notMerge: true, lazyUpdate: true });
        chart.resize();
        if (typeof ResizeObserver !== "undefined") {
          observer = new ResizeObserver(() => chart?.resize());
          observer.observe(el);
        }
      })
      .catch((err) => {
        console.error(`[${configRef.current.logTag}] echarts 渲染失败:`, err);
      });

    return () => {
      disposed = true;
      observer?.disconnect();
      cleanupInit?.();
      chart?.dispose();
      if (chartInstanceRef.current === chart) {
        chartInstanceRef.current = undefined;
      }
    };
  }, [containerRef]);
}
