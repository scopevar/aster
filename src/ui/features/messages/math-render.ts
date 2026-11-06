import katex from "katex";

export function renderMath(
  source: string,
  displayMode: boolean,
): { html: string; error?: never } | { error: string; html?: never } {
  if (source.length > 4_000)
    return { error: "公式超过 4,000 字符，请查看源码" };
  try {
    return {
      html: katex.renderToString(source, {
        displayMode,
        throwOnError: true,
        trust: false,
        strict: "error",
        maxExpand: 200,
        maxSize: 20,
        macros: {},
        output: "htmlAndMathml",
      }),
    };
  } catch (error) {
    return {
      error:
        error instanceof Error ? error.message.slice(0, 300) : "公式无法排版",
    };
  }
}
