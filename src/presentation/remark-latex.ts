import type { Processor } from "unified";
import type {
  Construct,
  State,
  Extension as SyntaxExtension,
} from "micromark-util-types";
import type { Extension } from "mdast-util-from-markdown";
declare module "unified" {
  interface Data {
    micromarkExtensions?: SyntaxExtension[] | undefined;
    fromMarkdownExtensions?: Extension[] | undefined;
  }
}

declare module "micromark-util-types" {
  interface TokenTypeMap {
    latexDelimited: "latexDelimited";
    latexDelimitedData: "latexDelimitedData";
  }
}

// A parser construct, not a text replacement: Markdown's code, escaped
// backslashes and link destinations retain their own grammar and original bytes.
const delimited: Construct = {
  name: "latexDelimited",
  tokenize(effects, ok, nok) {
    let close = 0;
    let consumed = 0;
    let dataOpen = false;
    const consume = (code: number) => {
      if (!dataOpen) {
        effects.enter("latexDelimitedData");
        dataOpen = true;
      }
      effects.consume(code);
    };
    const endData = () => {
      if (dataOpen) {
        effects.exit("latexDelimitedData");
        dataOpen = false;
      }
    };
    const start: State = (code) => {
      if (code !== 92) return nok(code);
      effects.enter("latexDelimited");
      consume(code);
      return opener;
    };
    const opener: State = (code) => {
      if (code !== 40 && code !== 91) return nok(code);
      close = code === 40 ? 41 : 93;
      consume(code);
      return body;
    };
    const body: State = (code) => {
      if (code === null || ++consumed > 4_004) return nok(code);
      if (code === -5 || code === -4 || code === -3) {
        endData();
        effects.enter("lineEnding");
        effects.consume(code);
        effects.exit("lineEnding");
        return body;
      }
      consume(code);
      return code === 92 ? escaped : body;
    };
    const escaped: State = (code) => {
      if (code === close) {
        consume(code);
        endData();
        effects.exit("latexDelimited");
        return ok;
      }
      if (code === 92) {
        consume(code);
        consumed++;
        return body;
      }
      return body(code);
    };
    return start;
  },
};
const fromMarkdown: Extension = {
  enter: {
    latexDelimited(token) {
      const raw = this.sliceSerialize(token);
      this.enter(
        {
          type: "inlineMath",
          value: raw.slice(2, -2),
          data: {
            hName: "code",
            hProperties: {
              className: [
                "language-math",
                raw[1] === "[" ? "math-display" : "math-inline",
              ],
            },
            hChildren: [{ type: "text", value: raw.slice(2, -2) }],
          },
        },
        token,
      );
      this.buffer();
    },
  },
  exit: {
    latexDelimited(token) {
      this.resume();
      this.exit(token);
    },
  },
};
export function remarkLatex(this: Processor) {
  const data = this.data();
  (data.micromarkExtensions ??= []).push({ text: { 92: delimited } });
  (data.fromMarkdownExtensions ??= []).push(fromMarkdown);
}
