"use client";

import { cn } from "@/lib/utils";
import * as echarts from "echarts";
import type { ECharts, EChartsOption } from "echarts";
import { CircleExclamation } from "@gravity-ui/icons";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";

export type ChartBlockProps = {
  className?: string;
  option: EChartsOption;
};

export type ChartBlockHandle = {
  getDataURL: () => string | null;
};

type ChartRecord = Record<string, unknown>;

function isUsableChartOption(option: unknown): option is EChartsOption {
  if (!option || typeof option !== "object" || Array.isArray(option)) return false;
  const value = option as Record<string, unknown>;
  return Boolean(value.series || value.dataset);
}

function isRecord(value: unknown): value is ChartRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasChartTitle(option: EChartsOption): boolean {
  const titles = Array.isArray(option.title) ? option.title : [option.title];
  return titles.some((title) => {
    if (!isRecord(title)) return false;
    return Boolean(title.text || title.subtext);
  });
}

function hasChartSubtext(option: EChartsOption): boolean {
  const titles = Array.isArray(option.title) ? option.title : [option.title];
  return titles.some((title) => isRecord(title) && Boolean(title.subtext));
}

function parsePixelValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)px?$/);
  return match ? Number(match[1]) : null;
}

function withMinimumGridTop(grid: unknown, minTop: number): ChartRecord {
  const next = isRecord(grid) ? { ...grid } : {};
  const currentTop = parsePixelValue(next.top);
  if (currentTop === null || currentTop < minTop) next.top = minTop;
  if (next.containLabel === undefined) next.containLabel = true;
  return next;
}

function normalizeChartLayout(option: EChartsOption): EChartsOption {
  if (!hasChartTitle(option)) return option;

  const minTop = hasChartSubtext(option) ? 144 : 112;
  return {
    ...option,
    grid: Array.isArray(option.grid)
      ? option.grid.map((grid) => withMinimumGridTop(grid, minTop))
      : withMinimumGridTop(option.grid, minTop),
  };
}

function stripJsonComments(value: string): string {
  return value
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function extractObjectLiteral(value: string): string {
  const trimmed = value
    .trim()
    .replace(/^export\s+default\s+/i, "")
    .replace(/^(?:const|let|var)\s+\w+\s*=\s*/i, "")
    .replace(/^\w+\s*=\s*/i, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

function repairLikelyJson(value: string): string {
  return stripJsonComments(extractObjectLiteral(value))
    .replace(/,\s*([}\]])/g, "$1")
    .replace(/([{,]\s*)([A-Za-z_$][\w$-]*)(\s*:)/g, '$1"$2"$3');
}

function previousNonWhitespace(value: string): string {
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const char = value[index];
    if (!/\s/.test(char)) return char;
  }
  return "";
}

function copyQuotedString(source: string, start: number): { text: string; end: number } {
  const quote = source[start];
  let index = start + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === quote) return { text: source.slice(start, index + 1), end: index + 1 };
    index += 1;
  }
  return { text: source.slice(start), end: source.length };
}

function findMatchingBrace(source: string, openIndex: number): number {
  let depth = 0;
  let index = openIndex;
  while (index < source.length) {
    const char = source[index];
    if (char === '"' || char === "'" || char === "`") {
      index = copyQuotedString(source, index).end;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
    index += 1;
  }
  return -1;
}

function stripFunctionValues(source: string): string {
  let output = "";
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === '"' || char === "'" || char === "`") {
      const copied = copyQuotedString(source, index);
      output += copied.text;
      index = copied.end;
      continue;
    }

    if (
      source.startsWith("function", index) &&
      previousNonWhitespace(output) === ":" &&
      !/[A-Za-z0-9_$]/.test(source[index + "function".length] || "")
    ) {
      const bodyStart = source.indexOf("{", index);
      const bodyEnd = bodyStart >= 0 ? findMatchingBrace(source, bodyStart) : -1;
      if (bodyEnd >= 0) {
        output += "null";
        index = bodyEnd + 1;
        continue;
      }
    }

    output += char;
    index += 1;
  }
  return output;
}

export function parseChartOption(code: string): EChartsOption | null {
  const repaired = repairLikelyJson(code);
  const candidates = [code.trim(), repaired, stripFunctionValues(repaired)];
  try {
    for (const candidate of candidates) {
      if (!candidate) continue;
      try {
        const parsed = JSON.parse(candidate);
        if (isUsableChartOption(parsed)) return parsed;
      } catch {
        // Try the next candidate.
      }
    }
  } catch {
    // Ignore malformed generated chart code.
  }
  return null;
}

export const ChartBlock = forwardRef<ChartBlockHandle, ChartBlockProps>(function ChartBlock(
  { className, option },
  ref
) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<ECharts | null>(null);
  const normalizedOption = useMemo(() => normalizeChartLayout(option), [option]);

  useImperativeHandle(ref, () => ({
    getDataURL: () => {
      const chart = chartRef.current;
      if (!chart || chart.isDisposed()) return null;
      return chart.getDataURL({
        backgroundColor: "#ffffff",
        excludeComponents: ["toolbox"],
        pixelRatio: 2,
        type: "png",
      });
    },
  }), []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const chart = echarts.init(root, undefined, { renderer: "canvas" });
    chartRef.current = chart;

    const resize = () => chart.resize();
    const frame = window.requestAnimationFrame(resize);
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null;
    observer?.observe(root);
    window.addEventListener("resize", resize);

    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", resize);
      chart.dispose();
      if (chartRef.current === chart) chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    chartRef.current?.setOption(normalizedOption, true);
  }, [normalizedOption]);

  if (!isUsableChartOption(option)) {
    return (
      <div className={cn("flex h-full items-center justify-center gap-2 text-muted-foreground text-sm", className)}>
        <CircleExclamation className="size-4" />
        <span>图表配置无效</span>
      </div>
    );
  }

  return <div aria-label="AI 生成图表" className={cn("h-full min-h-80 w-full", className)} ref={rootRef} role="img" />;
});

