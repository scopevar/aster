import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageMarkdown } from "../src/ui/features/messages/message-markdown.js";
import { renderMath } from "../src/ui/features/messages/math-render.js";
import {
  diagramSourceError,
  diagramInput,
  diagramResult,
} from "../src/ui/features/files/diagram-contract.js";

await test("message syntax separates math, code and unsafe markup", () => {
  const html = renderToStaticMarkup(
    createElement(MessageMarkdown, {
      text: '公式 $x^2$\n\n$$\n\\frac{1}{2}\n$$\n\n```ts\nconst x = "$raw$";\n```\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1))\n\n![private](file:///C:/secret)',
    }),
  );
  assert.match(html, /class="katex"/);
  assert.match(html, /katex-display/);
  assert.match(html, /const x = &quot;\$raw\$&quot;;/);
  assert.match(html, /复制代码/);
  assert.doesNotMatch(html, /<script|<img|href="(?:javascript|file):/);
});
await test("formula limits, malformed source and macro isolation retain visible errors", () => {
  assert.ok(renderMath("a".repeat(4001), false).error);
  assert.ok(renderMath("\\frac{", false).error);
  assert.ok(renderMath("\\def\\loop{\\loop}\\loop", false).error);
  assert.ok(renderMath("\\gdef\\private{123}\\private", false).html);
  assert.ok(renderMath("\\private", false).error);
  const link = renderMath("\\href{https://example.org}{link}", false);
  assert.doesNotMatch(link.html ?? "", /href=/);
});
await test("LaTeX delimiters respect code, escape and link boundaries without rewriting source", () => {
  const source =
    String.raw`Inline \(x_1 * y_2\), display \[
\begin{matrix}1 & 2 \\ 3 & 4\end{matrix}
\]

\(unclosed

\\(escaped\\)

` +
    "`\\(code\\)`\n\n```tex\n\\[code\\]\n```\n\n[link](https://example.com/\\(path\\))";
  const html = renderToStaticMarkup(
    createElement(MessageMarkdown, { text: source }),
  );
  assert.equal((html.match(/class="katex"/g) ?? []).length, 2);
  assert.equal((html.match(/class="katex-display"/g) ?? []).length, 1);
  assert.match(html, /x_1 \* y_2/);
  assert.doesNotMatch(html, /undefined/);
  assert.match(html, /<code>\\\(code\\\)<\/code>/);
  assert.match(html, /\\\[code\\\]/);
  assert.match(html, /unclosed/);
  assert.match(html, /escaped/);
  assert.match(html, /https:\/\/example.com\/\(path\)/);
});
await test("LaTeX parsing remains bounded with multiline, partial and escaped messages", () => {
  const bodies = [
    "",
    "x",
    "x\ny",
    "x\r\ny",
    "\\\\",
    "\\",
    "\t",
    "*x*",
    "a".repeat(4100),
  ];
  for (const open of ["\\(", "\\[", "\\\\("]) {
    for (const close of ["", "\\)", "\\]", "\\\\)"]) {
      for (const body of bodies) {
        const html = renderToStaticMarkup(
          createElement(MessageMarkdown, {
            text: `before ${open}${body}${close} after`,
          }),
        );
        assert.match(html, /before/);
        assert.match(html, /after/);
        assert.doesNotMatch(html, /undefined/);
      }
    }
  }
});
await test("diagram boundary rejects configuration injection, oversized input and unexpected messages", () => {
  assert.equal(diagramSourceError("flowchart LR\n A-->B"), null);
  assert.ok(
    diagramSourceError(
      '%%{init: {"securityLevel":"loose"}}%%\nflowchart LR\n A-->B',
    ),
  );
  assert.ok(diagramSourceError("---\nconfig: {}\n---\nflowchart LR"));
  assert.ok(diagramSourceError("a".repeat(12001)));
  assert.equal(
    diagramInput.safeParse({ version: 1, id: "wrong", source: "a" }).success,
    false,
  );
  assert.equal(
    diagramResult.safeParse({
      version: 1,
      id: crypto.randomUUID(),
      state: "ready",
      html: "<svg/>",
    }).success,
    false,
  );
});
