"use client";

import { Button } from "@/components/ui/aie-button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { createLiquidGlassBubbleMap, type GlassBubbleRadii, type GlassFilterMap } from "@/utils/liquidGlass";
import { Button as HeroButton, ButtonGroup, Dropdown, Label, Toolbar } from "@heroui/react";
import type { ChatStatus, FileUIPart } from "ai";
import {
  ArrowUp,
  ArrowsRotateLeft,
  CircleStop,
  File,
  Microphone,
  Picture,
  Plus,
  Xmark,
} from "@gravity-ui/icons";
import { nanoid } from "nanoid";
import {
  type ChangeEvent,
  type ChangeEventHandler,
  Children,
  type ClipboardEventHandler,
  type ComponentProps,
  createContext,
  type FormEvent,
  type FormEventHandler,
  Fragment,
  type HTMLAttributes,
  type KeyboardEventHandler,
  type PropsWithChildren,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

// ============================================================================
// Provider Context & Types
// ============================================================================

export type AttachmentsContext = {
  files: PromptInputFilePart[];
  add: (files: File[] | FileList) => void;
  remove: (id: string) => void;
  clear: () => void;
  openFileDialog: () => void;
  fileInputRef: RefObject<HTMLInputElement | null>;
};

type PromptInputFilePart = FileUIPart & {
  id: string;
  sizeBytes?: number;
};

export type PromptInputAttachmentError = {
  code: "max_files" | "max_file_size" | "accept";
  message: string;
};

export type PromptInputAttachmentConstraints = {
  accept?: string;
  maxFiles?: number;
  maxFileSize?: number;
  onError?: (error: PromptInputAttachmentError) => void;
};

const matchesFileAccept = (file: File, accept?: string) => {
  if (!accept?.trim()) {
    return true;
  }

  const fileType = file.type.toLowerCase();
  const filename = file.name.toLowerCase();

  return accept
    .split(",")
    .map((pattern) => pattern.trim().toLowerCase())
    .filter(Boolean)
    .some((pattern) => {
      if (pattern.startsWith(".")) {
        return filename.endsWith(pattern);
      }
      if (pattern.endsWith("/*")) {
        return fileType.startsWith(pattern.slice(0, -1));
      }
      return fileType === pattern;
    });
};

const getValidatedFiles = (
  fileList: File[] | FileList,
  currentFileCount: number,
  { accept, maxFiles, maxFileSize, onError }: PromptInputAttachmentConstraints
) => {
  const incoming = Array.from(fileList);
  const accepted = incoming.filter((file) => matchesFileAccept(file, accept));

  if (incoming.length > 0 && accepted.length === 0) {
    onError?.({
      code: "accept",
      message: "No files match the accepted types.",
    });
    return [];
  }

  const sized = accepted.filter((file) =>
    maxFileSize ? file.size <= maxFileSize : true
  );
  if (accepted.length > 0 && sized.length === 0) {
    onError?.({
      code: "max_file_size",
      message: "All files exceed the maximum size.",
    });
    return [];
  }

  const capacity =
    typeof maxFiles === "number"
      ? Math.max(0, maxFiles - currentFileCount)
      : undefined;
  const capped =
    typeof capacity === "number" ? sized.slice(0, capacity) : sized;

  if (typeof capacity === "number" && sized.length > capacity) {
    onError?.({
      code: "max_files",
      message: "Too many files. Some were not added.",
    });
  }

  return capped;
};

const createPromptInputFilePart = (file: File): PromptInputFilePart => ({
  id: nanoid(),
  type: "file",
  url: URL.createObjectURL(file),
  mediaType: file.type,
  filename: file.name,
  sizeBytes: file.size,
});

export type TextInputContext = {
  value: string;
  setInput: (v: string) => void;
  clear: () => void;
};

export type PromptInputControllerProps = {
  textInput: TextInputContext;
  attachments: AttachmentsContext;
  /** INTERNAL: Constraints owned by PromptInputProvider. */
  __attachmentConstraints?: PromptInputAttachmentConstraints;
  /** INTERNAL: Allows PromptInput to register its file textInput + "open" callback */
  __registerFileInput: (
    ref: RefObject<HTMLInputElement | null>,
    open: () => void
  ) => void;
};

const PromptInputController = createContext<PromptInputControllerProps | null>(
  null
);
const ProviderAttachmentsContext = createContext<AttachmentsContext | null>(
  null
);

export const usePromptInputController = () => {
  const ctx = useContext(PromptInputController);
  if (!ctx) {
    throw new Error(
      "Wrap your component inside <PromptInputProvider> to use usePromptInputController()."
    );
  }
  return ctx;
};

// Optional variants (do NOT throw). Useful for dual-mode components.
const useOptionalPromptInputController = () =>
  useContext(PromptInputController);

export const useProviderAttachments = () => {
  const ctx = useContext(ProviderAttachmentsContext);
  if (!ctx) {
    throw new Error(
      "Wrap your component inside <PromptInputProvider> to use useProviderAttachments()."
    );
  }
  return ctx;
};

const useOptionalProviderAttachments = () =>
  useContext(ProviderAttachmentsContext);

export type PromptInputProviderProps = PropsWithChildren<
  {
    initialInput?: string;
  } & PromptInputAttachmentConstraints
>;

/**
 * Optional global provider that lifts PromptInput state outside of PromptInput.
 * If you don't use it, PromptInput stays fully self-managed.
 */
export function PromptInputProvider({
  initialInput: initialTextInput = "",
  accept,
  maxFiles,
  maxFileSize,
  onError,
  children,
}: PromptInputProviderProps) {
  // ----- textInput state
  const [textInput, setTextInput] = useState(initialTextInput);
  const clearInput = useCallback(() => setTextInput(""), []);

  // ----- attachments state (global when wrapped)
  const [attachmentFiles, setAttachmentFiles] = useState<PromptInputFilePart[]>(
    []
  );
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const openRef = useRef<() => void>(() => {});

  const add = useCallback(
    (files: File[] | FileList) => {
      if (files.length === 0) {
        return;
      }

      setAttachmentFiles((prev) => {
        const validated = getValidatedFiles(files, prev.length, {
          accept,
          maxFiles,
          maxFileSize,
          onError,
        });
        return validated.length > 0
          ? prev.concat(validated.map(createPromptInputFilePart))
          : prev;
      });
    },
    [accept, maxFiles, maxFileSize, onError]
  );

  const remove = useCallback((id: string) => {
    setAttachmentFiles((prev) => {
      const found = prev.find((f) => f.id === id);
      if (found?.url) {
        URL.revokeObjectURL(found.url);
      }
      return prev.filter((f) => f.id !== id);
    });
  }, []);

  const clear = useCallback(() => {
    setAttachmentFiles((prev) => {
      for (const f of prev) {
        if (f.url) {
          URL.revokeObjectURL(f.url);
        }
      }
      return [];
    });
  }, []);

  // Keep a ref to attachments for cleanup on unmount (avoids stale closure)
  const attachmentsRef = useRef(attachmentFiles);
  attachmentsRef.current = attachmentFiles;

  // Cleanup blob URLs on unmount to prevent memory leaks
  useEffect(() => {
    return () => {
      for (const f of attachmentsRef.current) {
        if (f.url) {
          URL.revokeObjectURL(f.url);
        }
      }
    };
  }, []);

  const openFileDialog = useCallback(() => {
    openRef.current?.();
  }, []);

  const attachments = useMemo<AttachmentsContext>(
    () => ({
      files: attachmentFiles,
      add,
      remove,
      clear,
      openFileDialog,
      fileInputRef,
    }),
    [attachmentFiles, add, remove, clear, openFileDialog]
  );

  const __registerFileInput = useCallback(
    (ref: RefObject<HTMLInputElement | null>, open: () => void) => {
      fileInputRef.current = ref.current;
      openRef.current = open;
    },
    []
  );

  const controller = useMemo<PromptInputControllerProps>(
    () => ({
      textInput: {
        value: textInput,
        setInput: setTextInput,
        clear: clearInput,
      },
      attachments,
      __attachmentConstraints: {
        accept,
        maxFiles,
        maxFileSize,
        onError,
      },
      __registerFileInput,
    }),
    [
      textInput,
      clearInput,
      attachments,
      accept,
      maxFiles,
      maxFileSize,
      onError,
      __registerFileInput,
    ]
  );

  return (
    <PromptInputController.Provider value={controller}>
      <ProviderAttachmentsContext.Provider value={attachments}>
        {children}
      </ProviderAttachmentsContext.Provider>
    </PromptInputController.Provider>
  );
}

// ============================================================================
// Component Context & Hooks
// ============================================================================

const LocalAttachmentsContext = createContext<AttachmentsContext | null>(null);

export const usePromptInputAttachments = () => {
  // Dual-mode: prefer provider if present, otherwise use local
  const provider = useOptionalProviderAttachments();
  const local = useContext(LocalAttachmentsContext);
  const context = provider ?? local;
  if (!context) {
    throw new Error(
      "usePromptInputAttachments must be used within a PromptInput or PromptInputProvider"
    );
  }
  return context;
};

export type PromptInputAttachmentProps = HTMLAttributes<HTMLDivElement> & {
  data: FileUIPart & { id: string };
  className?: string;
};

export function PromptInputAttachment({
  data,
  className,
  ...props
}: PromptInputAttachmentProps) {
  const attachments = usePromptInputAttachments();

  const filename = data.filename || "";

  const mediaType =
    data.mediaType?.startsWith("image/") && data.url ? "image" : "file";
  const isImage = mediaType === "image";

  const attachmentLabel = filename || (isImage ? "图片" : "附件");
  const removeLabel = filename ? `移除附件：${filename}` : "移除附件";

  return (
    <PromptInputHoverCard>
      <HoverCardTrigger asChild>
        <div
          className={cn(
            "group relative flex h-10 max-w-full cursor-pointer select-none items-center gap-2 rounded-(--agent-radius,12px) border border-border/80 bg-background/55 py-1 pr-1 pl-2 font-medium text-sm shadow-xs backdrop-blur-sm transition-[background-color,border-color,box-shadow] hover:border-border hover:bg-accent/80 hover:text-accent-foreground hover:shadow-sm dark:bg-background/35 dark:hover:bg-accent/60",
            className
          )}
          key={data.id}
          {...props}
        >
          <div className="flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-(--agent-radius,10px) bg-background/80 text-muted-foreground ring-1 ring-border/60">
            {isImage ? (
              <img
                alt=""
                className="size-6 object-cover"
                height={24}
                src={data.url}
                width={24}
              />
            ) : (
              <File aria-hidden="true" className="size-3.5" />
            )}
          </div>

          <span className="min-w-0 flex-1 truncate">{attachmentLabel}</span>
          <Button
            aria-label={removeLabel}
            className="size-8 min-h-8 min-w-8 shrink-0 touch-manipulation cursor-pointer rounded-(--agent-radius,10px) p-0 text-muted-foreground opacity-70 transition-[color,background-color,opacity,box-shadow] hover:bg-background/80 hover:text-foreground hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 [&>svg]:size-3.5"
            onClick={(event) => {
              event.stopPropagation();
              attachments.remove(data.id);
            }}
            onPointerDown={(event) => event.stopPropagation()}
            title={removeLabel}
            type="button"
            variant="ghost"
          >
            <Xmark aria-hidden="true" />
            <span className="sr-only">{removeLabel}</span>
          </Button>
        </div>
      </HoverCardTrigger>
      <PromptInputHoverCardContent
        className="w-[min(22rem,calc(100vw-2rem))] overflow-hidden border-border/80 bg-popover p-0 shadow-xl"
        side="top"
        sideOffset={10}
      >
        {isImage && (
          <div className="flex aspect-[4/3] w-full items-center justify-center overflow-hidden bg-black/30">
            <img
              alt={filename ? `${filename} 的预览` : "附件预览"}
              className="size-full object-contain"
              height={264}
              src={data.url}
              width={352}
            />
          </div>
        )}
        <div className="flex min-h-14 items-center gap-2.5 border-border/70 border-t px-3 py-2.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-background/70 text-muted-foreground">
            {isImage ? <Picture aria-hidden="true" className="size-4" /> : <File aria-hidden="true" className="size-4" />}
          </span>
          <div className="min-w-0 flex-1">
            <h4 className="truncate font-medium text-sm leading-5">
              {filename || (isImage ? "图片" : "附件")}
            </h4>
            {data.mediaType && (
              <p className="truncate font-mono text-muted-foreground text-xs leading-4">
                {data.mediaType}
              </p>
            )}
          </div>
        </div>
      </PromptInputHoverCardContent>
    </PromptInputHoverCard>
  );
}

export type PromptInputAttachmentsProps = Omit<
  HTMLAttributes<HTMLDivElement>,
  "children"
> & {
  children: (attachment: FileUIPart & { id: string }) => ReactNode;
};

export function PromptInputAttachments({
  children,
  className,
  ...props
}: PromptInputAttachmentsProps) {
  const attachments = usePromptInputAttachments();

  if (!attachments.files.length) {
    return null;
  }

  return (
    <div
      className={cn("flex flex-wrap items-center gap-2 p-3 w-full", className)}
      {...props}
    >
      {attachments.files.map((file) => (
        <Fragment key={file.id}>{children(file)}</Fragment>
      ))}
    </div>
  );
}

export type PromptInputActionAddAttachmentsProps = ComponentProps<
  typeof Dropdown.Item
> & {
  label?: string;
};

export const PromptInputActionAddAttachments = ({
  label = "添加图片",
  ...props
}: PromptInputActionAddAttachmentsProps) => {
  const attachments = usePromptInputAttachments();

  return (
    <Dropdown.Item
      id="add-attachments"
      textValue={label}
      {...props}
      onAction={() => {
        attachments.openFileDialog();
      }}
    >
      <Picture />
      <Label>{label}</Label>
    </Dropdown.Item>
  );
};

export type PromptInputMessage = {
  text: string;
  files: FileUIPart[];
};

// 液态玻璃位移贴图参数：与 LiquidGlassBubble 同源的边缘折射带方案
const PROMPT_GLASS = { halfX: 0.22, halfY: 0.14, radius: 0.7, edge: 0.2, feather: 1.2, strength: 1.6 };

function readRadiusPx(value: string, fallback: number): number {
  const first = String(value || '').split(/\s+/)[0];
  const parsed = Number.parseFloat(first);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readGlassRadii(el: HTMLElement, width: number, height: number): GlassBubbleRadii {
  const style = getComputedStyle(el);
  const fallback = Math.min(40, Math.max(0, Math.min(width, height) / 2));
  return {
    topLeft: readRadiusPx(style.borderTopLeftRadius, fallback),
    topRight: readRadiusPx(style.borderTopRightRadius, fallback),
    bottomRight: readRadiusPx(style.borderBottomRightRadius, fallback),
    bottomLeft: readRadiusPx(style.borderBottomLeftRadius, fallback),
  };
}

export type PromptInputProps = Omit<
  HTMLAttributes<HTMLFormElement>,
  "onSubmit" | "onError"
> &
  PromptInputAttachmentConstraints & {
    multiple?: boolean;
    // Agent uses an opaque semantic surface and can opt out of the displacement
    // filter to keep focus feedback stable and avoid unnecessary map generation.
    enableLiquidGlass?: boolean;
    // When true, accepts drops anywhere on document. Default false (opt-in).
    globalDrop?: boolean;
    // Render a hidden input with given name and keep it in sync for native form posts. Default false.
    syncHiddenInput?: boolean;
    onSubmit: (
      message: PromptInputMessage,
      event: FormEvent<HTMLFormElement>
    ) => void | Promise<void>;
  };

export const PromptInput = ({
  className,
  accept,
  multiple,
  enableLiquidGlass = true,
  globalDrop,
  syncHiddenInput,
  maxFiles,
  maxFileSize,
  onError,
  onSubmit,
  children,
  ...props
}: PromptInputProps) => {
  // Try to use a provider controller if present
  const controller = useOptionalPromptInputController();
  const usingProvider = !!controller;

  // Refs
  const inputRef = useRef<HTMLInputElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);

  // ----- 液态玻璃：按 InputGroup 实际尺寸生成位移贴图，textarea 撑高/窗口缩放时跟随重建
  const glassRef = useRef<HTMLDivElement | null>(null);
  const [glassId] = useState(() => `prompt-input-glass-${nanoid(6)}`);
  const [glassMap, setGlassMap] = useState<GlassFilterMap | null>(null);

  useLayoutEffect(() => {
    if (!enableLiquidGlass) {
      setGlassMap(null);
      return;
    }
    const el = glassRef.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      if (width < 2 || height < 2) return;
      const next = createLiquidGlassBubbleMap(width, height, {
        ...PROMPT_GLASS,
        radii: readGlassRadii(el, width, height),
      });
      if (next) setGlassMap(next);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [enableLiquidGlass]);

  const glassBackdrop = glassMap
    ? `url(#${glassId}) blur(3px) saturate(180%) brightness(1.05)`
    : undefined;

  // ----- Local attachments (only used when no provider)
  const [items, setItems] = useState<PromptInputFilePart[]>([]);
  const files = usingProvider ? controller.attachments.files : items;

  // Keep a ref to files for cleanup on unmount (avoids stale closure)
  const filesRef = useRef(files);
  filesRef.current = files;

  const openFileDialogLocal = useCallback(() => {
    inputRef.current?.click();
  }, []);

  const addLocal = useCallback(
    (fileList: File[] | FileList) => {
      setItems((prev) => {
        const validated = getValidatedFiles(fileList, prev.length, {
          accept,
          maxFiles,
          maxFileSize,
          onError,
        });
        return validated.length > 0
          ? prev.concat(validated.map(createPromptInputFilePart))
          : prev;
      });
    },
    [accept, maxFiles, maxFileSize, onError]
  );

  const removeLocal = useCallback(
    (id: string) =>
      setItems((prev) => {
        const found = prev.find((file) => file.id === id);
        if (found?.url) {
          URL.revokeObjectURL(found.url);
        }
        return prev.filter((file) => file.id !== id);
      }),
    []
  );

  const clearLocal = useCallback(
    () =>
      setItems((prev) => {
        for (const file of prev) {
          if (file.url) {
            URL.revokeObjectURL(file.url);
          }
        }
        return [];
      }),
    []
  );

  const add = usingProvider ? controller.attachments.add : addLocal;
  const remove = usingProvider ? controller.attachments.remove : removeLocal;
  const clear = usingProvider ? controller.attachments.clear : clearLocal;
  const openFileDialog = usingProvider
    ? controller.attachments.openFileDialog
    : openFileDialogLocal;
  const fileInputAccept = usingProvider
    ? (controller.__attachmentConstraints?.accept ?? accept)
    : accept;

  const restoreTextareaFocus = useCallback(() => {
    window.requestAnimationFrame(() => {
      const textarea =
        formRef.current?.querySelector<HTMLTextAreaElement>(
          'textarea[name="message"]'
        );
      textarea?.focus();
    });
  }, []);

  // Let provider know about our hidden file input so external menus can call openFileDialog()
  useEffect(() => {
    if (!usingProvider) return;
    controller.__registerFileInput(inputRef, () => inputRef.current?.click());
  }, [usingProvider, controller]);

  // Note: File input cannot be programmatically set for security reasons
  // The syncHiddenInput prop is no longer functional
  useEffect(() => {
    if (syncHiddenInput && inputRef.current && files.length === 0) {
      inputRef.current.value = "";
    }
  }, [files, syncHiddenInput]);

  // Attach drop handlers on nearest form and document (opt-in)
  useEffect(() => {
    const form = formRef.current;
    if (!form) return;
    if (globalDrop) return // when global drop is on, let the document-level handler own drops

    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types?.includes("Files")) {
        e.preventDefault();
      }
    };
    const onDrop = (e: DragEvent) => {
      if (e.dataTransfer?.types?.includes("Files")) {
        e.preventDefault();
      }
      if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
        add(e.dataTransfer.files);
      }
    };
    form.addEventListener("dragover", onDragOver);
    form.addEventListener("drop", onDrop);
    return () => {
      form.removeEventListener("dragover", onDragOver);
      form.removeEventListener("drop", onDrop);
    };
  }, [add, globalDrop]);

  useEffect(() => {
    if (!globalDrop) return;

    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types?.includes("Files")) {
        e.preventDefault();
      }
    };
    const onDrop = (e: DragEvent) => {
      if (e.dataTransfer?.types?.includes("Files")) {
        e.preventDefault();
      }
      if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
        add(e.dataTransfer.files);
      }
    };
    document.addEventListener("dragover", onDragOver);
    document.addEventListener("drop", onDrop);
    return () => {
      document.removeEventListener("dragover", onDragOver);
      document.removeEventListener("drop", onDrop);
    };
  }, [add, globalDrop]);

  useEffect(
    () => () => {
      if (!usingProvider) {
        for (const f of filesRef.current) {
          if (f.url) URL.revokeObjectURL(f.url);
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cleanup only on unmount; filesRef always current
    [usingProvider]
  );

  const handleChange: ChangeEventHandler<HTMLInputElement> = (event) => {
    const hasFiles = Boolean(event.currentTarget.files?.length);
    if (event.currentTarget.files) {
      add(event.currentTarget.files);
    }
    // Reset input value to allow selecting files that were previously removed
    event.currentTarget.value = "";
    if (hasFiles) {
      restoreTextareaFocus();
    }
  };

  const convertBlobUrlToDataUrl = async (
    url: string
  ): Promise<string | null> => {
    try {
      const response = await fetch(url);
      const blob = await response.blob();
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      });
    } catch {
      return null;
    }
  };

  const ctx = useMemo<AttachmentsContext>(
    () => ({
      files: files.map((item) => ({ ...item, id: item.id })),
      add,
      remove,
      clear,
      openFileDialog,
      fileInputRef: inputRef,
    }),
    [files, add, remove, clear, openFileDialog]
  );

  const handleSubmit: FormEventHandler<HTMLFormElement> = (event) => {
    event.preventDefault();

    const form = event.currentTarget;
    const text = usingProvider
      ? controller.textInput.value
      : (() => {
          const formData = new FormData(form);
          return (formData.get("message") as string) || "";
        })();

    // Reset form immediately after capturing text to avoid race condition
    // where user input during async blob conversion would be lost
    if (!usingProvider) {
      form.reset();
    }

    // Convert blob URLs to data URLs asynchronously
    Promise.all(
      files.map(async ({ id, ...item }) => {
        if (item.url && item.url.startsWith("blob:")) {
          const dataUrl = await convertBlobUrlToDataUrl(item.url);
          // If conversion failed, keep the original blob URL
          return {
            ...item,
            url: dataUrl ?? item.url,
          };
        }
        return item;
      })
    )
      .then((convertedFiles: FileUIPart[]) => {
        try {
          const result = onSubmit({ text, files: convertedFiles }, event);

          // Handle both sync and async onSubmit
          if (result instanceof Promise) {
            result
              .then(() => {
                clear();
                if (usingProvider) {
                  controller.textInput.clear();
                }
              })
              .catch(() => {
                // Don't clear on error - user may want to retry
              });
          } else {
            // Sync function completed without throwing, clear attachments
            clear();
            if (usingProvider) {
              controller.textInput.clear();
            }
          }
        } catch {
          // Don't clear on error - user may want to retry
        }
      })
      .catch(() => {
        // Don't clear on error - user may want to retry
      });
  };

  // Render with or without local provider
  const inner = (
    <>
      <input
        accept={fileInputAccept}
        aria-label="上传文件"
        className="hidden"
        multiple={multiple}
        onChange={handleChange}
        ref={inputRef}
        title="上传文件"
        type="file"
      />
      <form
        className={cn("w-full", className)}
        onSubmit={handleSubmit}
        ref={formRef}
        {...props}
      >
        {enableLiquidGlass && glassMap && (
          <svg
            aria-hidden="true"
            focusable="false"
            style={{ position: "absolute", width: 0, height: 0, pointerEvents: "none" }}
          >
            <filter
              id={glassId}
              colorInterpolationFilters="sRGB"
              filterUnits="userSpaceOnUse"
              x="0"
              y="0"
              width={glassMap.width}
              height={glassMap.height}
            >
              <feImage
                href={glassMap.href}
                xlinkHref={glassMap.href}
                width={glassMap.width}
                height={glassMap.height}
                result="displacementMap"
              />
              <feDisplacementMap
                in="SourceGraphic"
                in2="displacementMap"
                scale={glassMap.scale}
                xChannelSelector="R"
                yChannelSelector="G"
              />
            </filter>
          </svg>
        )}
        <InputGroup
          className={cn(
            "overflow-hidden rounded-[40px] [corner-shape:superellipse(1.7)]",
            "has-[[data-slot=input-group-control]:focus-visible]:border-border!",
            "has-[[data-slot=input-group-control]:focus-visible]:ring-0!"
          )}
          ref={glassRef}
          style={
            enableLiquidGlass && glassBackdrop
              ? { backdropFilter: glassBackdrop, WebkitBackdropFilter: glassBackdrop }
              : undefined
          }
        >
          {children}
        </InputGroup>
      </form>
    </>
  );

  return usingProvider ? (
    inner
  ) : (
    <LocalAttachmentsContext.Provider value={ctx}>
      {inner}
    </LocalAttachmentsContext.Provider>
  );
};

export type PromptInputBodyProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputBody = ({
  className,
  ...props
}: PromptInputBodyProps) => (
  <div className={cn("contents", className)} {...props} />
);

export type PromptInputTextareaProps = ComponentProps<
  typeof InputGroupTextarea
>;

export const PromptInputTextarea = ({
  onChange,
  onKeyDown,
  onPaste,
  className,
  placeholder = "What would you like to know?",
  ...props
}: PromptInputTextareaProps) => {
  const controller = useOptionalPromptInputController();
  const attachments = usePromptInputAttachments();
  const [isComposing, setIsComposing] = useState(false);

  const handleKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = (e) => {
    onKeyDown?.(e);
    if (e.defaultPrevented) {
      return;
    }

    if (e.key === "Enter") {
      if (isComposing || e.nativeEvent.isComposing) {
        return;
      }
      if (e.shiftKey) {
        return;
      }
      e.preventDefault();

      // Check if the submit button is disabled before submitting
      const form = e.currentTarget.form;
      const submitButton = form?.querySelector(
        'button[type="submit"]'
      ) as HTMLButtonElement | null;
      if (submitButton?.disabled) {
        return;
      }

      form?.requestSubmit();
    }

    // Remove last attachment when Backspace is pressed and textarea is empty
    if (
      e.key === "Backspace" &&
      e.currentTarget.value === "" &&
      attachments.files.length > 0
    ) {
      e.preventDefault();
      const lastAttachment = attachments.files[attachments.files.length - 1];
      if (lastAttachment) {
        attachments.remove(lastAttachment.id);
      }
    }
  };

  const handlePaste: ClipboardEventHandler<HTMLTextAreaElement> = (event) => {
    onPaste?.(event);
    if (event.defaultPrevented) {
      return;
    }

    const items = event.clipboardData?.items;

    if (!items) {
      return;
    }

    const files: File[] = [];

    for (const item of items) {
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) {
          files.push(file);
        }
      }
    }

    if (files.length > 0) {
      event.preventDefault();
      attachments.add(files);
    }
  };

  const controlledProps = controller
    ? {
        value: controller.textInput.value,
        onChange: (e: ChangeEvent<HTMLTextAreaElement>) => {
          controller.textInput.setInput(e.currentTarget.value);
          onChange?.(e);
        },
      }
    : {
        onChange,
      };

  return (
    <InputGroupTextarea
      className={cn("field-sizing-content max-h-48 min-h-16", className)}
      name="message"
      onCompositionEnd={() => setIsComposing(false)}
      onCompositionStart={() => setIsComposing(true)}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      placeholder={placeholder}
      {...props}
      {...controlledProps}
    />
  );
};

export type PromptInputHeaderProps = Omit<
  ComponentProps<typeof InputGroupAddon>,
  "align"
>;

export const PromptInputHeader = ({
  className,
  ...props
}: PromptInputHeaderProps) => (
  <InputGroupAddon
    align="block-end"
    className={cn("order-first flex-wrap gap-1", className)}
    {...props}
  />
);

export type PromptInputFooterProps = Omit<
  ComponentProps<typeof InputGroupAddon>,
  "align"
>;

export const PromptInputFooter = ({
  className,
  ...props
}: PromptInputFooterProps) => (
  <InputGroupAddon
    align="block-end"
    className={cn("justify-between gap-1", className)}
    {...props}
  />
);

export type PromptInputToolsProps = Omit<
  ComponentProps<typeof Toolbar>,
  "className"
> & {
  className?: string;
};

export const PromptInputTools = ({
  "aria-label": ariaLabel = "输入工具",
  className,
  ...props
}: PromptInputToolsProps) => (
  <Toolbar
    aria-label={ariaLabel}
    className={cn("max-w-full gap-2", className)}
    {...props}
  />
);

type HeroButtonProps = ComponentProps<typeof HeroButton>;

export type PromptInputButtonProps = Omit<
  HeroButtonProps,
  "children" | "className" | "isDisabled" | "size" | "variant"
> & {
  children?: ReactNode;
  className?: string;
  disabled?: boolean;
  isDisabled?: boolean;
  showGroupSeparator?: boolean;
  size?: HeroButtonProps["size"] | "icon-sm";
  title?: string;
  variant?: HeroButtonProps["variant"] | "default";
};

export const PromptInputButton = ({
  variant = "ghost",
  "aria-label": ariaLabel,
  className,
  disabled,
  isDisabled,
  showGroupSeparator,
  size,
  title,
  children,
  ...props
}: PromptInputButtonProps) => {
  const isIconOnly = size === "icon-sm" || Children.count(children) === 1;
  const heroSize = size === "icon-sm" ? "sm" : (size ?? "sm");
  const heroVariant = variant === "default" ? "primary" : variant;

  return (
    <HeroButton
      aria-label={ariaLabel ?? title}
      className={cn(
        isIconOnly && "size-8 p-0",
        className
      )}
      isDisabled={isDisabled ?? disabled}
      isIconOnly={isIconOnly}
      size={heroSize}
      type="button"
      variant={heroVariant}
      {...props}
    >
      {showGroupSeparator && <ButtonGroup.Separator />}
      {children}
    </HeroButton>
  );
};

export type PromptInputActionMenuProps = ComponentProps<typeof Dropdown>;
export const PromptInputActionMenu = (props: PromptInputActionMenuProps) => (
  <Dropdown {...props} />
);

export type PromptInputActionMenuTriggerProps = PromptInputButtonProps;

export const PromptInputActionMenuTrigger = ({
  className,
  children,
  ...props
}: PromptInputActionMenuTriggerProps) => (
  <PromptInputButton className={className} {...props}>
    {children ?? <Plus className="size-4" />}
  </PromptInputButton>
);

export type PromptInputActionMenuContentProps = ComponentProps<
  typeof Dropdown.Menu
>;
export const PromptInputActionMenuContent = ({
  children,
  ...props
}: PromptInputActionMenuContentProps) => (
  <Dropdown.Popover placement="top start">
    <Dropdown.Menu {...props}>{children}</Dropdown.Menu>
  </Dropdown.Popover>
);

export type PromptInputActionMenuItemProps = ComponentProps<
  typeof Dropdown.Item
> & {
  onSelect?: () => void;
};
export const PromptInputActionMenuItem = ({
  children,
  onSelect,
  onAction,
  textValue,
  ...props
}: PromptInputActionMenuItemProps) => (
  <Dropdown.Item
    textValue={textValue ?? (typeof children === "string" ? children : undefined)}
    {...props}
    onAction={onAction ?? onSelect}
  >
    {children}
  </Dropdown.Item>
);

// Note: Actions that perform side-effects (like opening a file dialog)
// are provided in opt-in modules (e.g., prompt-input-attachments).

export type PromptInputSubmitProps = PromptInputButtonProps & {
  status?: ChatStatus;
};

export const PromptInputSubmit = ({
  "aria-label": ariaLabel,
  className,
  variant = "default",
  size = "icon-sm",
  disabled,
  isDisabled,
  ref: forwardedRef,
  showGroupSeparator,
  status,
  title,
  children,
  ...props
}: PromptInputSubmitProps) => {
  let Icon = <ArrowUp className="size-4" />;
  let actionLabel = "发送消息";

  if (status === "submitted" || status === "streaming") {
    Icon = <CircleStop className="size-4 animate-pulse" />;
    actionLabel = "停止生成";
  } else if (status === "error") {
    Icon = <ArrowsRotateLeft className="size-4" />;
    actionLabel = "重试发送";
  }

  // React Aria filters `title`, so sync it on the native button while preserving
  // the public ref contract.
  const setButtonRef = useCallback(
    (node: HTMLButtonElement | null) => {
      if (node) {
        node.title = title ?? actionLabel;
      }
      if (typeof forwardedRef === "function") {
        forwardedRef(node);
      } else if (forwardedRef) {
        forwardedRef.current = node;
      }
    },
    [actionLabel, forwardedRef, title]
  );

  return (
    <HeroButton
      aria-label={ariaLabel ?? actionLabel}
      className={cn("size-8 p-0", className)}
      isDisabled={isDisabled ?? disabled}
      isIconOnly
      ref={setButtonRef}
      size={size === "icon-sm" ? "sm" : size}
      type="submit"
      variant={variant === "default" ? "primary" : variant}
      {...props}
    >
      {showGroupSeparator && <ButtonGroup.Separator />}
      {children ?? Icon}
    </HeroButton>
  );
};

interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onstart: ((this: SpeechRecognition, ev: Event) => any) | null;
  onend: ((this: SpeechRecognition, ev: Event) => any) | null;
  onresult:
    | ((this: SpeechRecognition, ev: SpeechRecognitionEvent) => any)
    | null;
  onerror:
    | ((this: SpeechRecognition, ev: SpeechRecognitionErrorEvent) => any)
    | null;
}

interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}

type SpeechRecognitionResultList = {
  readonly length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
};

type SpeechRecognitionResult = {
  readonly length: number;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
  isFinal: boolean;
};

type SpeechRecognitionAlternative = {
  transcript: string;
  confidence: number;
};

interface SpeechRecognitionErrorEvent extends Event {
  error: string;
}

declare global {
  interface Window {
    SpeechRecognition: {
      new (): SpeechRecognition;
    };
    webkitSpeechRecognition: {
      new (): SpeechRecognition;
    };
  }
}

type LocalRecorder = {
  audioContext: AudioContext;
  chunks: Float32Array[];
  processor: ScriptProcessorNode;
  source: MediaStreamAudioSourceNode;
  stream: MediaStream;
};

const mergeAudioChunks = (chunks: Float32Array[]) => {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const merged = new Float32Array(length);
  let offset = 0;

  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  return merged;
};

const writeString = (view: DataView, offset: number, value: string) => {
  for (let i = 0; i < value.length; i++) {
    view.setUint8(offset + i, value.charCodeAt(i));
  }
};

const encodeWav = (samples: Float32Array, sampleRate: number) => {
  const bytesPerSample = 2;
  const channelCount = 1;
  const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
  const view = new DataView(buffer);

  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + samples.length * bytesPerSample, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channelCount * bytesPerSample, true);
  view.setUint16(32, channelCount * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, "data");
  view.setUint32(40, samples.length * bytesPerSample, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const sample = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }

  return buffer;
};

const getWhisperLanguage = (language: string) => {
  const normalized = language.toLowerCase();
  if (normalized.startsWith("zh")) {
    return "zh";
  }
  if (normalized.startsWith("en")) {
    return "en";
  }
  return "auto";
};

export type PromptInputSpeechButtonProps = ComponentProps<
  typeof PromptInputButton
> & {
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  language?: string;
  onTranscriptionChange?: (text: string) => void;
};

export const PromptInputSpeechButton = ({
  className,
  language = "en-US",
  textareaRef,
  onTranscriptionChange,
  ...props
}: PromptInputSpeechButtonProps) => {
  const [isListening, setIsListening] = useState(false);
  const [isPreparingRecording, setIsPreparingRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [statusLabel, setStatusLabel] = useState<string | null>(null);
  const [recognition, setRecognition] = useState<SpeechRecognition | null>(
    null
  );
  const controller = useOptionalPromptInputController();
  const controllerRef = useRef(controller);
  const recorderRef = useRef<LocalRecorder | null>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  controllerRef.current = controller;

  const isElectron =
    typeof window !== "undefined" && Boolean((window as any).electronAPI);
  const hasLocalWhisper =
    isElectron && Boolean((window as any).electronAPI?.sttWhisper);

  const appendTranscript = useCallback(
    (transcript: string) => {
      const text = transcript.trim();
      if (!text) {
        return;
      }

      if (textareaRef?.current) {
        const textarea = textareaRef.current;
        const currentValue = textarea.value;
        const newValue = currentValue + (currentValue ? " " : "") + text;

        textarea.value = newValue;
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        onTranscriptionChange?.(newValue);
        return;
      }

      if (controllerRef.current) {
        const currentValue = controllerRef.current.textInput.value;
        const newValue = currentValue + (currentValue ? " " : "") + text;

        controllerRef.current.textInput.setInput(newValue);
        onTranscriptionChange?.(newValue);
      }
    },
    [textareaRef, onTranscriptionChange]
  );

  useEffect(() => {
    if (isElectron) {
      setRecognition(null);
      return;
    }

    if (
      typeof window !== "undefined" &&
      ("SpeechRecognition" in window || "webkitSpeechRecognition" in window)
    ) {
      const SpeechRecognition =
        window.SpeechRecognition || window.webkitSpeechRecognition;
      const speechRecognition = new SpeechRecognition();

      speechRecognition.continuous = true;
      speechRecognition.interimResults = true;
      speechRecognition.lang = language;

      speechRecognition.onstart = () => {
        setIsListening(true);
      };

      speechRecognition.onend = () => {
        setIsListening(false);
      };

      speechRecognition.onresult = (event) => {
        let finalTranscript = "";

        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          if (result.isFinal) {
            finalTranscript += result[0]?.transcript ?? "";
          }
        }

        if (finalTranscript) {
          appendTranscript(finalTranscript);
        }
      };

      speechRecognition.onerror = (event) => {
        console.error("Speech recognition error:", event.error);
        setIsListening(false);
        if (event.error === "network" || event.error === "not-allowed") {
          recognitionRef.current?.stop();
        }
      };

      recognitionRef.current = speechRecognition;
      setRecognition(speechRecognition);
    }

    return () => {
      if (recognitionRef.current) {
        recognitionRef.current.stop();
      }
    };
  }, [appendTranscript, isElectron, language]);

  useEffect(
    () => () => {
      const recorder = recorderRef.current;
      if (!recorder) {
        return;
      }

      recorder.processor.disconnect();
      recorder.source.disconnect();
      recorder.stream.getTracks().forEach((track) => track.stop());
      void recorder.audioContext.close();
      recorderRef.current = null;
    },
    []
  );

  const ensureWhisperModel = useCallback(async () => {
    if (!hasLocalWhisper) {
      setStatusLabel("当前环境不支持本地语音输入");
      return null;
    }

    const electronAPI = (window as any).electronAPI;
    const modelType =
      ((await electronAPI.config?.get?.("whisperModelType")) as string) ||
      "small";
    const modelStatus = await electronAPI.sttWhisper.checkModel(modelType);

    if (modelStatus.exists) {
      return modelType;
    }

    const shouldDownload = window.confirm(
      `Whisper ${modelType} 模型未下载，是否现在下载？\n下载完成后即可免费本地语音输入。`
    );

    if (!shouldDownload) {
      setStatusLabel("本地模型未下载");
      return null;
    }

    setStatusLabel("正在下载语音模型...");
    const removeProgress = electronAPI.sttWhisper.onDownloadProgress(
      (progress: { percent?: number }) => {
        if (typeof progress.percent === "number") {
          setStatusLabel(`正在下载语音模型 ${progress.percent.toFixed(1)}%`);
        }
      }
    );

    try {
      const result = await electronAPI.sttWhisper.downloadModel(modelType);
      if (!result.success) {
        setStatusLabel(result.error || "语音模型下载失败");
        return null;
      }

      setStatusLabel("语音模型已就绪");
      return modelType;
    } finally {
      removeProgress?.();
    }
  }, [hasLocalWhisper]);

  const startLocalRecording = useCallback(async () => {
    if (isPreparingRecording || isTranscribing) {
      return;
    }

    try {
      setIsPreparingRecording(true);
      const modelType = await ensureWhisperModel();
      if (!modelType) {
        return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      const AudioContextCtor =
        window.AudioContext || (window as any).webkitAudioContext;
      const audioContext = new AudioContextCtor();
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      const chunks: Float32Array[] = [];

      processor.onaudioprocess = (event) => {
        chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
      };

      source.connect(processor);
      processor.connect(audioContext.destination);

      recorderRef.current = {
        audioContext,
        chunks,
        processor,
        source,
        stream,
      };
      setStatusLabel(`正在录音，使用 Whisper ${modelType}`);
      setIsListening(true);
    } catch (error) {
      console.error("Local speech recording failed:", error);
      setStatusLabel("无法开始录音");
      setIsListening(false);
    } finally {
      setIsPreparingRecording(false);
    }
  }, [ensureWhisperModel, isPreparingRecording, isTranscribing]);

  const stopLocalRecording = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder) {
      return;
    }

    recorderRef.current = null;
    setIsListening(false);

    recorder.processor.disconnect();
    recorder.source.disconnect();
    recorder.stream.getTracks().forEach((track) => track.stop());
    await recorder.audioContext.close();

    const samples = mergeAudioChunks(recorder.chunks);
    if (samples.length === 0) {
      setStatusLabel("没有录到声音");
      return;
    }

    try {
      setIsTranscribing(true);
      setStatusLabel("正在本地转写...");
      const electronAPI = (window as any).electronAPI;
      const modelType =
        ((await electronAPI.config?.get?.("whisperModelType")) as string) ||
        "small";
      const wavData = encodeWav(samples, recorder.audioContext.sampleRate);
      const result = await electronAPI.sttWhisper.transcribe(wavData, {
        modelType,
        language: getWhisperLanguage(language),
      });

      if (result.success && result.transcript) {
        appendTranscript(result.transcript);
        setStatusLabel("本地转写完成");
      } else {
        setStatusLabel(result.error || "本地转写失败");
      }
    } catch (error) {
      console.error("Local speech transcription failed:", error);
      setStatusLabel("本地转写失败");
    } finally {
      setIsTranscribing(false);
    }
  }, [appendTranscript, language]);

  const toggleListening = useCallback(() => {
    if (hasLocalWhisper) {
      if (isPreparingRecording) {
        return;
      }

      if (isListening) {
        void stopLocalRecording();
      } else {
        void startLocalRecording();
      }
      return;
    }

    if (!recognition) {
      return;
    }

    try {
      if (isListening) {
        recognition.stop();
      } else {
        recognition.start();
      }
    } catch (error) {
      console.error("Speech recognition toggle failed:", error);
      setIsListening(false);
    }
  }, [
    hasLocalWhisper,
    isListening,
    isPreparingRecording,
    recognition,
    startLocalRecording,
    stopLocalRecording,
  ]);

  const buttonTitle = isListening
    ? "停止录音并转写"
    : isPreparingRecording
      ? statusLabel || "正在准备本地语音输入..."
      : isTranscribing
      ? "正在本地转写..."
      : statusLabel || (hasLocalWhisper ? "免费本地语音输入" : props.title);

  return (
    <PromptInputButton
      className={cn(
        "relative transition-all duration-200",
        isListening && "animate-pulse bg-accent text-accent-foreground",
        (isPreparingRecording || isTranscribing) && "animate-pulse",
        className
      )}
      disabled={
        isPreparingRecording ||
        isTranscribing ||
        (!hasLocalWhisper && !recognition)
      }
      onPress={toggleListening}
      title={
        buttonTitle ||
        (recognition ? props.title : "当前环境不支持语音输入")
      }
      {...props}
    >
      {isPreparingRecording || isTranscribing ? (
        <ArrowsRotateLeft className="size-4 animate-spin" />
      ) : (
        <Microphone className="size-4" />
      )}
    </PromptInputButton>
  );
};

export type PromptInputSelectProps = ComponentProps<typeof Select>;

export const PromptInputSelect = (props: PromptInputSelectProps) => (
  <Select {...props} />
);

export type PromptInputSelectTriggerProps = ComponentProps<
  typeof SelectTrigger
>;

export const PromptInputSelectTrigger = ({
  className,
  ...props
}: PromptInputSelectTriggerProps) => (
  <SelectTrigger
    className={cn(
      "rounded-(--agent-radius,12px) border-none bg-transparent font-medium text-muted-foreground shadow-none transition-colors",
      "hover:bg-accent hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground",
      className
    )}
    {...props}
  />
);

export type PromptInputSelectContentProps = ComponentProps<
  typeof SelectContent
>;

export const PromptInputSelectContent = ({
  className,
  ...props
}: PromptInputSelectContentProps) => (
  <SelectContent className={cn("rounded-(--agent-radius,12px)", className)} {...props} />
);

export type PromptInputSelectItemProps = ComponentProps<typeof SelectItem>;

export const PromptInputSelectItem = ({
  className,
  ...props
}: PromptInputSelectItemProps) => (
  <SelectItem className={cn("rounded-(--agent-radius,12px)", className)} {...props} />
);

export type PromptInputSelectValueProps = ComponentProps<typeof SelectValue>;

export const PromptInputSelectValue = ({
  className,
  ...props
}: PromptInputSelectValueProps) => (
  <SelectValue className={cn(className)} {...props} />
);

export type PromptInputHoverCardProps = ComponentProps<typeof HoverCard>;

export const PromptInputHoverCard = ({
  openDelay = 0,
  closeDelay = 0,
  ...props
}: PromptInputHoverCardProps) => (
  <HoverCard closeDelay={closeDelay} openDelay={openDelay} {...props} />
);

export type PromptInputHoverCardTriggerProps = ComponentProps<
  typeof HoverCardTrigger
>;

export const PromptInputHoverCardTrigger = (
  props: PromptInputHoverCardTriggerProps
) => <HoverCardTrigger {...props} />;

export type PromptInputHoverCardContentProps = ComponentProps<
  typeof HoverCardContent
>;

export const PromptInputHoverCardContent = ({
  align = "start",
  className,
  ...props
}: PromptInputHoverCardContentProps) => (
  <HoverCardContent align={align} className={cn("rounded-(--agent-radius,12px)", className)} {...props} />
);

export type PromptInputTabsListProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputTabsList = ({
  className,
  ...props
}: PromptInputTabsListProps) => <div className={cn(className)} {...props} />;

export type PromptInputTabProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputTab = ({
  className,
  ...props
}: PromptInputTabProps) => <div className={cn(className)} {...props} />;

export type PromptInputTabLabelProps = HTMLAttributes<HTMLHeadingElement>;

export const PromptInputTabLabel = ({
  className,
  ...props
}: PromptInputTabLabelProps) => (
  <h3
    className={cn(
      "mb-2 px-3 font-medium text-muted-foreground text-xs",
      className
    )}
    {...props}
  />
);

export type PromptInputTabBodyProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputTabBody = ({
  className,
  ...props
}: PromptInputTabBodyProps) => (
  <div className={cn("space-y-1", className)} {...props} />
);

export type PromptInputTabItemProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputTabItem = ({
  className,
  ...props
}: PromptInputTabItemProps) => (
  <div
    className={cn(
      "flex items-center gap-2 px-3 py-2 text-xs hover:bg-accent",
      className
    )}
    {...props}
  />
);

export type PromptInputCommandProps = ComponentProps<typeof Command>;

export const PromptInputCommand = ({
  className,
  ...props
}: PromptInputCommandProps) => <Command className={cn(className)} {...props} />;

export type PromptInputCommandInputProps = ComponentProps<typeof CommandInput>;

export const PromptInputCommandInput = ({
  className,
  ...props
}: PromptInputCommandInputProps) => (
  <CommandInput className={cn(className)} {...props} />
);

export type PromptInputCommandListProps = ComponentProps<typeof CommandList>;

export const PromptInputCommandList = ({
  className,
  ...props
}: PromptInputCommandListProps) => (
  <CommandList className={cn(className)} {...props} />
);

export type PromptInputCommandEmptyProps = ComponentProps<typeof CommandEmpty>;

export const PromptInputCommandEmpty = ({
  className,
  ...props
}: PromptInputCommandEmptyProps) => (
  <CommandEmpty className={cn(className)} {...props} />
);

export type PromptInputCommandGroupProps = ComponentProps<typeof CommandGroup>;

export const PromptInputCommandGroup = ({
  className,
  ...props
}: PromptInputCommandGroupProps) => (
  <CommandGroup className={cn(className)} {...props} />
);

export type PromptInputCommandItemProps = ComponentProps<typeof CommandItem>;

export const PromptInputCommandItem = ({
  className,
  ...props
}: PromptInputCommandItemProps) => (
  <CommandItem className={cn(className)} {...props} />
);

export type PromptInputCommandSeparatorProps = ComponentProps<
  typeof CommandSeparator
>;

export const PromptInputCommandSeparator = ({
  className,
  ...props
}: PromptInputCommandSeparatorProps) => (
  <CommandSeparator className={cn(className)} {...props} />
);
