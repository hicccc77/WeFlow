"use client";

import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { IconComponent } from "@/types/icon";
import { Bulb, ChevronDown, CircleFill } from "@gravity-ui/icons";
import type { ComponentProps, ReactNode } from "react";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

// 本地等价实现，避免依赖 @radix-ui/react-use-controllable-state（项目用统一的 radix-ui 包）
function useControllableState({
  prop,
  defaultProp,
  onChange,
}: {
  prop?: boolean;
  defaultProp: boolean;
  onChange?: (value: boolean) => void;
}): [boolean, (value: boolean) => void] {
  const [uncontrolled, setUncontrolled] = useState(defaultProp);
  const isControlled = prop !== undefined;
  const value = isControlled ? (prop as boolean) : uncontrolled;
  const setValue = useCallback(
    (next: boolean) => {
      if (!isControlled) {
        setUncontrolled(next);
      }
      onChange?.(next);
    },
    [isControlled, onChange]
  );
  return [value, setValue];
}

interface ChainOfThoughtContextValue {
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
}

const ChainOfThoughtContext = createContext<ChainOfThoughtContextValue | null>(
  null
);

const useChainOfThought = () => {
  const context = useContext(ChainOfThoughtContext);
  if (!context) {
    throw new Error(
      "ChainOfThought components must be used within ChainOfThought"
    );
  }
  return context;
};

export type ChainOfThoughtProps = ComponentProps<"div"> & {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
};

export const ChainOfThought = memo(
  ({
    className,
    open,
    defaultOpen = false,
    onOpenChange,
    children,
    ...props
  }: ChainOfThoughtProps) => {
    const [isOpen, setIsOpen] = useControllableState({
      defaultProp: defaultOpen,
      onChange: onOpenChange,
      prop: open,
    });

    const chainOfThoughtContext = useMemo(
      () => ({ isOpen, setIsOpen }),
      [isOpen, setIsOpen]
    );

    return (
      <ChainOfThoughtContext.Provider value={chainOfThoughtContext}>
        <div
          className={cn(
            "not-prose w-full space-y-0 rounded-lg border border-border/50 bg-card/40 p-3.5",
            className
          )}
          {...props}
        >
          {children}
        </div>
      </ChainOfThoughtContext.Provider>
    );
  }
);

export type ChainOfThoughtHeaderProps = ComponentProps<
  typeof CollapsibleTrigger
> & {
  icon?: IconComponent | null;
};

export const ChainOfThoughtHeader = memo(
  ({ className, children, icon: Icon = Bulb, ...props }: ChainOfThoughtHeaderProps) => {
    const { isOpen, setIsOpen } = useChainOfThought();

    return (
      <Collapsible className="w-full max-w-full" onOpenChange={setIsOpen} open={isOpen}>
        <CollapsibleTrigger
          className={cn(
            "inline-flex min-h-9 w-full max-w-full cursor-pointer items-center gap-3 rounded-md px-1 py-1 text-[13px] font-medium leading-5 text-muted-foreground outline-none transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
            className
          )}
          {...props}
        >
          {Icon && (
            <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-md border border-border/50 bg-background/60 text-muted-foreground" aria-hidden>
              <Icon className="size-3.5" />
            </span>
          )}
          <span className="min-w-0 flex-1 truncate text-left">
            {children ?? "Chain of Thought"}
          </span>
          <ChevronDown
            className={cn(
              "size-4 shrink-0 transition-transform",
              isOpen ? "rotate-180" : "rotate-0"
            )}
          />
        </CollapsibleTrigger>
      </Collapsible>
    );
  }
);

export type ChainOfThoughtStepProps = ComponentProps<"div"> & {
  icon?: IconComponent;
  label: ReactNode;
  description?: ReactNode;
  status?: "complete" | "active" | "pending";
};

const stepStatusStyles = {
  active: "text-foreground",
  complete: "text-muted-foreground",
  pending: "text-muted-foreground/50",
};

export const ChainOfThoughtStep = memo(
  ({
    className,
    icon: Icon = CircleFill,
    label,
    description,
    status = "complete",
    children,
    ...props
  }: ChainOfThoughtStepProps) => (
    <div
      className={cn(
        "flex gap-2.5 text-[13px] leading-5",
        stepStatusStyles[status],
        "fade-in-0 slide-in-from-top-2 animate-in motion-reduce:animate-none",
        className
      )}
      {...props}
    >
      <div className="relative mt-0.5 shrink-0">
        <span className="inline-flex size-5 items-center justify-center rounded-full bg-background text-muted-foreground ring-1 ring-border/60">
          <Icon className="size-3" />
        </span>
        <div className="absolute top-7 bottom-0 left-1/2 -mx-px w-px bg-border/70" />
      </div>
      <div className="flex-1 space-y-2 overflow-hidden">
        <div>{label}</div>
        {description && (
          <div className="text-xs leading-5 text-muted-foreground">{description}</div>
        )}
        {children}
      </div>
    </div>
  )
);

export type ChainOfThoughtDisclosureStepProps = Omit<
  ComponentProps<typeof Collapsible>,
  "children" | "open"
> & {
  icon?: IconComponent | null;
  label: ReactNode;
  open: boolean;
  status?: "complete" | "active" | "pending";
  children?: ReactNode;
};

export const ChainOfThoughtDisclosureStep = memo(
  ({
    className,
    icon: Icon = CircleFill,
    label,
    status = "complete",
    children,
    open,
    ...props
  }: ChainOfThoughtDisclosureStepProps) => (
    <Collapsible
      className={cn(
        "relative text-[13px] leading-5",
        stepStatusStyles[status],
        "fade-in-0 slide-in-from-top-2 animate-in motion-reduce:animate-none",
        className
      )}
      open={open}
      {...props}
    >
      <CollapsibleTrigger className="agent-tool-step-trigger flex min-h-8 w-fit max-w-full cursor-pointer items-center gap-2.5 rounded-md border-0 bg-transparent p-0 text-left text-inherit outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50">
        {Icon && (
          <span className="inline-flex size-5 items-center justify-center rounded-full bg-background text-muted-foreground ring-1 ring-border/60" aria-hidden>
            <Icon className="size-3" />
          </span>
        )}
        <span className="min-w-0">{label}</span>
        <ChevronDown
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            open ? "rotate-180" : "rotate-0"
          )}
        />
      </CollapsibleTrigger>
      <span aria-hidden className="absolute top-7 bottom-0 left-2.5 -mx-px w-px bg-border/70" />
      <CollapsibleContent className="ml-[30px] mt-2 space-y-2 overflow-hidden outline-none data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-1 data-[state=open]:slide-in-from-top-1 data-[state=closed]:animate-out data-[state=open]:animate-in motion-reduce:animate-none">
        {children}
      </CollapsibleContent>
    </Collapsible>
  )
);

export type ChainOfThoughtSearchResultsProps = ComponentProps<"div">;

export const ChainOfThoughtSearchResults = memo(
  ({ className, ...props }: ChainOfThoughtSearchResultsProps) => (
    <div
      className={cn("flex w-fit max-w-full flex-wrap items-center gap-2", className)}
      {...props}
    />
  )
);

export type ChainOfThoughtSearchResultProps = ComponentProps<typeof Badge>;

export const ChainOfThoughtSearchResult = memo(
  ({ className, children, ...props }: ChainOfThoughtSearchResultProps) => (
    <Badge
      className={cn("max-w-full gap-1 rounded-md px-2 py-1 font-normal text-xs leading-4", className)}
      variant="secondary"
      {...props}
    >
      {children}
    </Badge>
  )
);

export type ChainOfThoughtContentProps = ComponentProps<
  typeof CollapsibleContent
>;

export const ChainOfThoughtContent = memo(
  ({ className, children, ...props }: ChainOfThoughtContentProps) => {
    const { isOpen } = useChainOfThought();

    return (
      <Collapsible open={isOpen}>
        <CollapsibleContent
          className={cn(
            "mt-3 space-y-3 border-border/50 border-t pt-3",
            "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 text-popover-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in motion-reduce:animate-none",
            className
          )}
          {...props}
        >
          {children}
        </CollapsibleContent>
      </Collapsible>
    );
  }
);

export type ChainOfThoughtImageProps = ComponentProps<"div"> & {
  caption?: string;
};

export const ChainOfThoughtImage = memo(
  ({ className, children, caption, ...props }: ChainOfThoughtImageProps) => (
    <div className={cn("mt-2 space-y-2", className)} {...props}>
      <div className="relative flex max-h-[22rem] items-center justify-center overflow-hidden rounded-(--agent-radius,12px) border border-border/50 bg-background/60 p-3">
        {children}
      </div>
      {caption && <p className="text-muted-foreground text-xs">{caption}</p>}
    </div>
  )
);

ChainOfThought.displayName = "ChainOfThought";
ChainOfThoughtHeader.displayName = "ChainOfThoughtHeader";
ChainOfThoughtStep.displayName = "ChainOfThoughtStep";
ChainOfThoughtDisclosureStep.displayName = "ChainOfThoughtDisclosureStep";
ChainOfThoughtSearchResults.displayName = "ChainOfThoughtSearchResults";
ChainOfThoughtSearchResult.displayName = "ChainOfThoughtSearchResult";
ChainOfThoughtContent.displayName = "ChainOfThoughtContent";
ChainOfThoughtImage.displayName = "ChainOfThoughtImage";
