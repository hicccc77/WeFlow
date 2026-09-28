import type { BlockProps } from "streamdown";

type StreamdownAnimatePlugin = NonNullable<BlockProps["animatePlugin"]>;

type HastText = {
  type: "text";
  value: string;
};

type HastElement = {
  type: "element";
  tagName: string;
  properties?: Record<string, unknown>;
  children: HastNode[];
};

type HastParent = {
  type: string;
  children: HastNode[];
};

type HastNode = HastText | HastElement | HastParent | { type: string };

type GraphemeSegmenter = {
  segment: (input: string) => Iterable<{ segment: string }>;
};

type GraphemeSegmenterConstructor = new (
  locale?: string | string[],
  options?: { granularity: "grapheme" }
) => GraphemeSegmenter;

export const MAX_STREAMING_ANIMATED_GRAPHEMES = 192;

const NON_ANIMATED_TAGS = new Set(["annotation", "code", "math", "pre", "svg"]);
const STREAMING_ANIMATION_DURATION_MS = 160;
const STREAMING_ANIMATION_STAGGER_MS = 2;
const STREAMING_ANIMATION_EASING = "cubic-bezier(.22, 1, .36, 1)";
const WHITESPACE_PATTERN = /^\s+$/u;

const segmenter = (() => {
  const Segmenter = (Intl as typeof Intl & { Segmenter?: GraphemeSegmenterConstructor }).Segmenter;
  return Segmenter ? new Segmenter(undefined, { granularity: "grapheme" }) : null;
})();

function splitGraphemes(value: string): string[] {
  if (!segmenter) return Array.from(value);
  return Array.from(segmenter.segment(value), ({ segment }) => segment);
}

function isTextNode(node: HastNode): node is HastText {
  return node.type === "text" && "value" in node && typeof node.value === "string";
}

function isParentNode(node: HastNode): node is HastParent {
  return "children" in node && Array.isArray(node.children);
}

function isSkippedElement(node: HastNode): boolean {
  return (
    node.type === "element" &&
    "tagName" in node &&
    typeof node.tagName === "string" &&
    NON_ANIMATED_TAGS.has(node.tagName)
  );
}

function countNewGraphemes(tree: HastNode, previousContentLength: number) {
  let characterCount = 0;
  let newGraphemeCount = 0;

  const visit = (node: HastNode) => {
    if (isSkippedElement(node)) return;

    if (isTextNode(node)) {
      const start = characterCount;
      characterCount += node.value.length;
      if (characterCount <= previousContentLength) return;

      const newText = node.value.slice(Math.max(0, previousContentLength - start));
      for (const grapheme of splitGraphemes(newText)) {
        if (!WHITESPACE_PATTERN.test(grapheme)) newGraphemeCount += 1;
      }
      return;
    }

    if (isParentNode(node)) {
      for (const child of node.children) visit(child);
    }
  };

  visit(tree);
  return { characterCount, newGraphemeCount };
}

function appendText(nodes: HastNode[], value: string) {
  if (!value) return;
  const previous = nodes[nodes.length - 1];
  if (previous && isTextNode(previous)) {
    previous.value += value;
    return;
  }
  nodes.push({ type: "text", value });
}

function createAnimatedSpan(value: string, animationIndex: number): HastElement {
  return {
    type: "element",
    tagName: "span",
    properties: {
      "data-sd-animate": true,
      style: [
        "--sd-animation:sd-fadeIn",
        `--sd-duration:${STREAMING_ANIMATION_DURATION_MS}ms`,
        `--sd-easing:${STREAMING_ANIMATION_EASING}`,
        `--sd-delay:${animationIndex * STREAMING_ANIMATION_STAGGER_MS}ms`,
      ].join(";"),
    },
    children: [{ type: "text", value }],
  };
}

/**
 * Streamdown's built-in character animation keeps one span for every character
 * already rendered. This plugin keeps previous text as plain text and wraps only
 * the latest streamed suffix. Large reconnect/buffer flushes are fully rendered,
 * but only their final bounded suffix is animated.
 */
export function createIncrementalAnimatePlugin(
  maxAnimatedGraphemes = MAX_STREAMING_ANIMATED_GRAPHEMES
): StreamdownAnimatePlugin {
  let previousContentLength = 0;
  let lastRenderCharCount = 0;

  const rehypePlugin = () => (tree: HastNode) => {
    const measurement = countNewGraphemes(tree, previousContentLength);
    let characterCount = 0;
    let animationIndex = 0;
    let graphemesToSkip = Math.max(0, measurement.newGraphemeCount - maxAnimatedGraphemes);

    const visit = (node: HastNode) => {
      if (isSkippedElement(node) || !isParentNode(node)) return;

      for (let index = 0; index < node.children.length; index += 1) {
        const child = node.children[index];
        if (isSkippedElement(child)) continue;

        if (!isTextNode(child)) {
          visit(child);
          continue;
        }

        const start = characterCount;
        characterCount += child.value.length;
        if (characterCount <= previousContentLength || !child.value.trim()) continue;

        const suffixStart = Math.max(0, previousContentLength - start);
        const replacement: HastNode[] = [];
        appendText(replacement, child.value.slice(0, suffixStart));

        for (const grapheme of splitGraphemes(child.value.slice(suffixStart))) {
          if (WHITESPACE_PATTERN.test(grapheme)) {
            appendText(replacement, grapheme);
          } else if (graphemesToSkip > 0) {
            graphemesToSkip -= 1;
            appendText(replacement, grapheme);
          } else {
            replacement.push(createAnimatedSpan(grapheme, animationIndex));
            animationIndex += 1;
          }
        }

        node.children.splice(index, 1, ...replacement);
        index += replacement.length - 1;
      }
    };

    visit(tree);
    lastRenderCharCount = measurement.characterCount;
    previousContentLength = 0;
  };

  return {
    name: "animate",
    type: "animate",
    rehypePlugin: rehypePlugin as StreamdownAnimatePlugin["rehypePlugin"],
    setPrevContentLength(length) {
      previousContentLength = length;
    },
    getLastRenderCharCount() {
      const count = lastRenderCharCount;
      lastRenderCharCount = 0;
      return count;
    },
  };
}
