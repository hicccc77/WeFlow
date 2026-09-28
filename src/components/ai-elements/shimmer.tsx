"use client";

import { cn } from "@/lib/utils";
import { motion } from "motion/react";
import {
  Children,
  type CSSProperties,
  type ElementType,
  type JSX,
  type ReactNode,
  isValidElement,
  memo,
  useMemo,
} from "react";

export type TextShimmerProps = {
  children: ReactNode;
  as?: ElementType;
  className?: string;
  duration?: number;
  spread?: number;
};

function textLengthOf(node: ReactNode): number {
  let length = 0;
  Children.forEach(node, (child) => {
    if (typeof child === "string" || typeof child === "number") {
      length += String(child).length;
      return;
    }
    if (isValidElement<{ children?: ReactNode }>(child)) {
      length += textLengthOf(child.props.children);
    }
  });
  return length;
}

const ShimmerComponent = ({
  children,
  as: Component = "p",
  className,
  duration = 2,
  spread = 2,
}: TextShimmerProps) => {
  // motion.create 返回新的 React 组件类型；流式渲染时若每次都重新创建，会持续
  // 卸载/挂载无限循环动画。按元素类型缓存后动画可以连续播放，不改变任何视觉参数。
  const MotionComponent = useMemo(
    () => motion.create(Component as keyof JSX.IntrinsicElements),
    [Component]
  );

  const dynamicSpread = useMemo(
    () => textLengthOf(children) * spread,
    [children, spread]
  );

  return (
    <MotionComponent
      animate={{ backgroundPosition: "0% center" }}
      className={cn(
        "relative inline-block bg-[length:250%_100%,auto] bg-clip-text text-transparent",
        "[--bg:linear-gradient(90deg,#0000_calc(50%-var(--spread)),var(--color-background),#0000_calc(50%+var(--spread)))] [background-repeat:no-repeat,padding-box]",
        className
      )}
      initial={{ backgroundPosition: "100% center" }}
      style={
        {
          "--spread": `${dynamicSpread}px`,
          backgroundImage:
            "var(--bg), linear-gradient(var(--color-muted-foreground), var(--color-muted-foreground))",
        } as CSSProperties
      }
      transition={{
        repeat: Number.POSITIVE_INFINITY,
        duration,
        ease: "linear",
      }}
    >
      {children}
    </MotionComponent>
  );
};

export const Shimmer = memo(ShimmerComponent);
