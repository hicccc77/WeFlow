type MarkdownNode = {
  type: string;
  value?: string;
  children?: MarkdownNode[];
};

const STRONG_PUNCTUATION_BOUNDARY = /\*\*([^*\r\n]+?)(\p{P}+)\*\*(?=[^\s\p{P}])/gu;
const NON_TEXT_CONTAINERS = new Set(["code", "html", "inlineCode", "strong"]);

function isMarkdownNode(value: unknown): value is MarkdownNode {
  return Boolean(value) && typeof value === "object" && "type" in value!;
}

function textNode(value: string): MarkdownNode {
  return { type: "text", value };
}

function splitInvalidStrongBoundary(value: string): MarkdownNode[] | null {
  const output: MarkdownNode[] = [];
  let cursor = 0;
  let matched = false;

  STRONG_PUNCTUATION_BOUNDARY.lastIndex = 0;
  for (const match of value.matchAll(STRONG_PUNCTUATION_BOUNDARY)) {
    const index = match.index;
    const content = match[1];
    const punctuation = match[2];
    if (index === undefined || !content || !punctuation) continue;

    matched = true;
    if (index > cursor) output.push(textNode(value.slice(cursor, index)));
    output.push({
      type: "strong",
      children: [textNode(content)],
    });
    output.push(textNode(punctuation));
    cursor = index + match[0].length;
  }

  if (!matched) return null;
  if (cursor < value.length) output.push(textNode(value.slice(cursor)));
  return output;
}

function normalizeStrongBoundaries(node: MarkdownNode): void {
  if (NON_TEXT_CONTAINERS.has(node.type) || !Array.isArray(node.children)) return;

  for (let index = 0; index < node.children.length; index += 1) {
    const child = node.children[index];
    if (child.type !== "text" || typeof child.value !== "string") {
      normalizeStrongBoundaries(child);
      continue;
    }

    const replacement = splitInvalidStrongBoundary(child.value);
    if (!replacement) continue;
    node.children.splice(index, 1, ...replacement);
    index += replacement.length - 1;
  }
}

/**
 * CommonMark does not close `**` when the delimiter is preceded by Unicode
 * punctuation and immediately followed by ordinary text (`**标题。**正文`).
 * Recover that common model-output shape in the Markdown AST so persisted
 * messages render correctly without rewriting their stored source text.
 */
export function remarkNormalizeStrongPunctuationBoundary() {
  return (tree: unknown) => {
    if (isMarkdownNode(tree)) normalizeStrongBoundaries(tree);
  };
}
