"use client";

import { Disclosure, Link } from "@heroui/react";
import { cn } from "@/lib/utils";
import { Book, ChevronDown } from "@gravity-ui/icons";
import type { ComponentProps } from "react";

export type SourcesProps = ComponentProps<typeof Disclosure>;

export const Sources = ({ className, ...props }: SourcesProps) => (
  <Disclosure
    className={cn("not-prose mb-4 text-primary text-xs", className)}
    {...props}
  />
);

export type SourcesTriggerProps = ComponentProps<typeof Disclosure.Trigger> & {
  count: number;
};

export const SourcesTrigger = ({
  className,
  count,
  children,
  ...props
}: SourcesTriggerProps) => (
  <Disclosure.Heading>
    <Disclosure.Trigger
      className={cn("flex items-center gap-2", className)}
      {...props}
    >
      {children ?? (
        <>
          <p className="font-medium">Used {count} sources</p>
          <Disclosure.Indicator>
            <ChevronDown className="h-4 w-4" />
          </Disclosure.Indicator>
        </>
      )}
    </Disclosure.Trigger>
  </Disclosure.Heading>
);

export type SourcesContentProps = ComponentProps<typeof Disclosure.Body>;

export const SourcesContent = ({
  className,
  ...props
}: SourcesContentProps) => (
  <Disclosure.Content>
    <Disclosure.Body
      className={cn("mt-3 flex w-fit flex-col gap-2 outline-none", className)}
      {...props}
    />
  </Disclosure.Content>
);

export type SourceProps = ComponentProps<typeof Link> & {
  title?: string;
};

const EXTERNAL_HREF_RE = /^(https?:)?\/\//i;

function toExternalHref(href: string): string {
  return href.startsWith("//") ? `https:${href}` : href;
}

export const Source = ({ href, title, children, ...props }: SourceProps) => {
  const external = Boolean(href && EXTERNAL_HREF_RE.test(href));

  return (
    <Link
      className="flex items-center gap-2"
      href={href}
      {...props}
      onClick={(event) => {
        props.onClick?.(event);
        if (event.defaultPrevented || !external || !href) return;
        event.preventDefault();
        void window.electronAPI.shell.openExternal(toExternalHref(href));
      }}
      rel={external ? "noreferrer" : props.rel}
      target={external ? "_blank" : props.target}
    >
      {children ?? (
        <>
          <Book className="h-4 w-4" />
          <span className="block font-medium">{title}</span>
        </>
      )}
    </Link>
  );
};

