"use client";

import { ScrollShadow } from "@heroui/react";
import { Button } from "@/components/ui/aie-button";
import { cn } from "@/lib/utils";
import { ArrowDown } from "@gravity-ui/icons";
import type { ComponentProps } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";

export type ConversationProps = ComponentProps<typeof StickToBottom>;

export const Conversation = ({ className, ...props }: ConversationProps) => (
  <StickToBottom
    className={cn("relative flex-1 overflow-y-hidden", className)}
    initial="instant"
    // 流式内容长高时瞬时贴底：弹簧动画(欠阻尼)会过冲回弹，叠加 50ms 批量更新就是肉眼可见的上下抖
    resize="instant"
    role="log"
    {...props}
  />
);

export type ConversationContentProps = ComponentProps<
  typeof StickToBottom.Content
>;

export const ConversationContent = ({
  className,
  children,
  scrollClassName,
  style,
  ...props
}: ConversationContentProps) => {
  const context = useStickToBottomContext();
  const { state } = context;
  const contentNodeRef = useRef<HTMLDivElement | null>(null);

  // 流式消息会让此组件高频重渲染。ref 若写成内联函数，React 会在每次渲染时先用
  // null 卸载旧 ref、再绑定同一个 DOM 节点，连带让 use-stick-to-bottom 反复重建
  // scroll/wheel 监听器和 ResizeObserver，并重新启动一次贴底任务。工具卡片挂载时的
  // 高度变化会把这类无效工作放大；稳定 ref 可以保留原滚动/动画语义，同时消除抖动源。
  const setScrollNode = useCallback((node: HTMLDivElement | null) => {
    context.scrollRef(node);
  }, [context.scrollRef]);

  const setContentNode = useCallback((node: HTMLDivElement | null) => {
    contentNodeRef.current = node;
    context.contentRef(node);
  }, [context.contentRef]);

  // 贴底校正（双向）：钉在底部时把 scrollTop 同步对齐到目标位置。
  // - 变高：库自身的校正走 ResizeObserver→rAF 排到下一帧，会先画出"冒在底部的新内容"
  //   下一帧才跳上去，50ms 一批就是持续抖动，所以必须在绘制前同步钉回。
  // - 变矮（思考块收起、表格占位消失等）：浏览器原生 clamp 产生的滚动事件没有
  //   ignoreScrollToTop 标记，库靠 resizeDifference + setTimeout(1) 去猜，竞态漏掉时
  //   会被误判成"用户向上滚"→ 解除贴底锁 → 后续校正全部晚一帧 = 滚动条上下抽搐。
  //   这里主动用 state.scrollTop setter 对齐（自带 ignoreScrollToTop 标记），让 clamp
  //   场景也走"程序滚动"路径，不触发误逃逸；用户真实向上滚仍由 wheel/scroll 正常逃逸。
  const pinToBottom = useCallback(() => {
    if (!state.isAtBottom || state.escapedFromLock) return;
    const target = state.calculatedTargetScrollTop;
    if (Math.abs(state.scrollTop - target) > 0.5) {
      state.scrollTop = target;
    }
  }, [state]);

  // React 提交引起的高度变化：绘制前同步钉回。
  useLayoutEffect(pinToBottom);

  // React 之外的高度变化（radix 折叠动画结束、图片/字体加载、异步高亮等）：
  // ResizeObserver 回调在布局后、绘制前触发，同样能赶在这一帧画出来之前钉回。
  useEffect(() => {
    const node = contentNodeRef.current;
    if (!node) return;
    const observer = new ResizeObserver(pinToBottom);
    observer.observe(node);
    return () => observer.disconnect();
  }, [pinToBottom]);

  return (
    <ScrollShadow
      className={cn("h-full min-h-0 w-full", scrollClassName)}
      ref={setScrollNode}
      size={56}
      style={{ overflowAnchor: "none" }}
    >
      <div
        className={cn("flex flex-col gap-8", className)}
        ref={setContentNode}
        style={{ overflowAnchor: "none", ...style }}
        {...props}
      >
        {typeof children === "function" ? children(context) : children}
      </div>
    </ScrollShadow>
  );
};

export type ConversationEmptyStateProps = ComponentProps<"div"> & {
  title?: string;
  description?: string;
  icon?: React.ReactNode;
};

export const ConversationEmptyState = ({
  className,
  title = "No messages yet",
  description = "Start a conversation to see messages here",
  icon,
  children,
  ...props
}: ConversationEmptyStateProps) => (
  <div
    className={cn(
      "flex size-full flex-col items-center justify-center gap-3 p-8 text-center",
      className
    )}
    {...props}
  >
    {children ?? (
      <>
        {icon && <div className="text-muted-foreground">{icon}</div>}
        <div className="space-y-1">
          <h3 className="font-medium text-sm">{title}</h3>
          {description && (
            <p className="text-muted-foreground text-sm">{description}</p>
          )}
        </div>
      </>
    )}
  </div>
);

export type ConversationScrollButtonProps = ComponentProps<typeof Button>;

export type ConversationAutoScrollProps = {
  enabled?: boolean;
  trigger: unknown;
};

export const ConversationAutoScroll = ({
  enabled = true,
  trigger,
}: ConversationAutoScrollProps) => {
  const { scrollToBottom } = useStickToBottomContext();
  const didMountRef = useRef(false);

  useLayoutEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    if (!enabled) return;
    // ignoreEscapes 会随"没追上目标就重排队"传递下去，流式期间动画一直活着，
    // 用户中途上滚会被每个滚动事件强制拽回底部，和贴底校正互踢直到爆 React 更新深度。
    // 锚定是瞬时向下跳、逃逸只认向上滚，本就不需要免打扰保护。
    void scrollToBottom({ animation: "instant" });
  }, [enabled, scrollToBottom, trigger]);

  return null;
};

export const ConversationScrollButton = ({
  className,
  ...props
}: ConversationScrollButtonProps) => {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();

  const handleScrollToBottom = useCallback(() => {
    scrollToBottom();
  }, [scrollToBottom]);

  return (
    !isAtBottom && (
      <Button
        aria-label="回到最新消息"
        className={cn(
          "absolute bottom-4 left-[50%] translate-x-[-50%] rounded-(--agent-radius,12px) border-border bg-background/90 shadow-sm backdrop-blur",
          className
        )}
        onClick={handleScrollToBottom}
        size="icon"
        title="回到最新消息"
        type="button"
        variant="outline"
        {...props}
      >
        <ArrowDown className="size-4" />
      </Button>
    )
  );
};
