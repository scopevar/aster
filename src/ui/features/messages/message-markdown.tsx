import { Button } from "@heroui/react";
/** @jsxRuntime automatic */
import { memo, useCallback, useMemo, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { renderMath } from "./math-render.js";
import { DiagramPreview } from "../files/diagram-preview.js";
import { officeLink } from "../../../shared/files/office.js";
import { desktop, errorMessage } from "../../lib/client.js";
import { messageMarkdownPlugins } from "../../../presentation/message-markdown.js";

function MathContent({
  source,
  display,
}: {
  source: string;
  display: boolean;
}) {
  const result = useMemo(() => renderMath(source, display), [source, display]);
  return result.html !== undefined ? (
    <span
      className="message-math"
      dangerouslySetInnerHTML={{ __html: result.html }}
    />
  ) : (
    <span className="math-error">
      <code>{source}</code>
      <span role="note">公式无法排版：{result.error}</span>
    </span>
  );
}
function CodeBlock({ source, language }: { source: string; language: string }) {
  const [status, setStatus] = useState("");
  const [pending, setPending] = useState(false);
  const [diagram, setDiagram] = useState(false);
  const closeDiagram = useCallback(() => setDiagram(false), []);
  return (
    <div className="message-code">
      <div className="code-toolbar">
        <span>{language || "代码"}</span>
        <Button
          variant="ghost"
          size="sm"
          isDisabled={pending}
          onClick={() => {
            setPending(true);
            setStatus("");
            void desktop
              .copyText(source)
              .then(
                () => setStatus("已复制代码"),
                (error) => setStatus(errorMessage(error)),
              )
              .finally(() => setPending(false));
          }}
        >
          复制代码
        </Button>
        {language === "mermaid" && (
          <Button variant="ghost" size="sm" onClick={() => setDiagram(true)}>
            查看图表
          </Button>
        )}
      </div>
      {status && <span role="status">{status}</span>}
      <pre>
        <code>{source}</code>
      </pre>
      {diagram && <DiagramPreview source={source} onClose={closeDiagram} />}
    </div>
  );
}
function MessageLink({
  href,
  children,
}: {
  href: string | undefined;
  children: React.ReactNode;
}) {
  const [error, setError] = useState("");
  const safe = href ? officeLink(href) : null;
  return (
    <>
      {safe ? (
        <a
          href={safe}
          title={safe}
          onClick={(event) => {
            event.preventDefault();
            setError("");
            void desktop
              .openDocumentLink(safe)
              .catch((error) => setError(errorMessage(error)));
          }}
        >
          {children}
        </a>
      ) : (
        <span>{children}</span>
      )}
      {error && <span role="alert">{error}</span>}
    </>
  );
}
const components: Components = {
  pre: ({ node, children }) => {
    const code = node?.children[0];
    if (code?.type !== "element" || code.tagName !== "code")
      return <pre>{children}</pre>;
    const source = code.children
      .map((child) => (child.type === "text" ? child.value : ""))
      .join("")
      .replace(/\n$/, "");
    const classes = Array.isArray(code.properties.className)
      ? code.properties.className.map(String)
      : [];
    if (classes.includes("math-display"))
      return <MathContent source={source} display />;
    return (
      <CodeBlock
        source={source}
        language={
          classes.find((value) => value.startsWith("language-"))?.slice(9) ?? ""
        }
      />
    );
  },
  code: ({ className, children }) =>
    className
      ?.split(" ")
      .some((value) => value === "math-inline" || value === "math-display") ? (
      <MathContent
        source={String(children ?? "")}
        display={className.split(" ").includes("math-display")}
      />
    ) : (
      <code className={className}>{children}</code>
    ),
  a: ({ href, children }) => <MessageLink href={href}>{children}</MessageLink>,
  img: ({ alt, src }) => (
    <span className="message-image-link">
      [图片：{alt || "未命名"}]{" "}
      <MessageLink href={src}>打开图片链接</MessageLink>
    </span>
  ),
};
export const MessageMarkdown = memo(function MessageMarkdown({
  text,
}: {
  text: string;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={messageMarkdownPlugins}
      components={components}
      skipHtml
    >
      {text}
    </ReactMarkdown>
  );
});
