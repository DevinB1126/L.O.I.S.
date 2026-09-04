import { memo, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface MessageContentProps {
  text: string;
}

// Chat workspace pass (Objective B12/B13) — renders an assistant (or user)
// message's text as Markdown: paragraphs, headings, bold/italic, bullet
// and numbered lists, inline code, fenced code blocks, blockquotes, and
// links. react-markdown never interprets HTML found in the source as live
// markup unless rehype-raw is explicitly added (it isn't here), so this is
// safe by construction — no unsanitized HTML/script execution risk from
// message content, without needing a separate sanitizer pass.
//
// Performance Pass v1 (Objective 17) — wrapped in React.memo, keyed on
// `text` only. ChatTranscript re-renders its full message list on every
// streamed chunk (useChat.sendMessage replaces the messages array wholesale
// so the currently-growing reply's text updates), which previously forced
// EVERY prior message in the transcript to re-run its full ReactMarkdown
// parse on every single token — not just the one actually changing. Only
// the streaming message's `text` prop changes per chunk, so memoizing here
// is a targeted fix (not a blanket "memo everything" pass) that lets every
// already-finished message skip re-parsing entirely.
export const MessageContent = memo(function MessageContent({ text }: MessageContentProps) {
  return (
    <div className="message-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: CodeBlock,
          code: InlineCode,
          a: (props) => <a {...props} target="_blank" rel="noopener noreferrer" />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

// react-markdown (v9+) no longer passes an `inline` flag to `code` — the
// reliable way to tell inline code from a fenced block is that a fenced
// block's `code` element is always wrapped in `pre`, which is why `pre` is
// overridden separately below (Objective B13's language label + Copy) and
// this `code` override only ever fires for genuinely inline `` `code` ``.
function InlineCode({ children }: { children?: ReactNode }) {
  return <code className="inline-code">{children}</code>;
}

// Objective B13 — clear visual separation, preserved whitespace, horizontal
// scroll for long lines, a language label when the fence declared one
// (```ts -> "ts"), and a Copy button. Deliberately NOT a syntax-highlighting
// library (Objective B13: "do not add a massive code editor library just
// for display") — clean monospace formatting with a language label already
// satisfies the objective without the bundle/complexity cost of per-
// language grammars.
function CodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);

  const codeElement = Array.isArray(children) ? children[0] : children;
  const className =
    codeElement && typeof codeElement === "object" && "props" in codeElement
      ? ((codeElement as { props?: { className?: string } }).props?.className ?? "")
      : "";
  const language = /language-(\w+)/.exec(className)?.[1];
  const codeText = getPlainText(children);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(codeText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API can be unavailable (permissions, insecure context) —
      // failing silently here is preferable to breaking the message render
      // over a non-essential convenience action.
    }
  }

  return (
    <div className="code-block">
      <div className="code-block-header">
        <span className="code-block-language">{language ?? "code"}</span>
        <button type="button" className="code-block-copy" onClick={handleCopy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="code-block-pre">{children}</pre>
    </div>
  );
}

function getPlainText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(getPlainText).join("");
  if (node && typeof node === "object" && "props" in node) {
    return getPlainText((node as { props?: { children?: ReactNode } }).props?.children);
  }
  return "";
}
