import * as React from "react";
import { useState } from "react";
import { Copy, Check } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="wb-icon"
      title={copied ? "Copied" : "Copy"}
      aria-label="Copy"
      onClick={() => {
        void navigator.clipboard
          .writeText(text)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => setCopied(false));
      }}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}
export function MarkdownContent({ text }: { text: string }) {
  return (
    <div className="wb-markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          img: ({ alt }) => (
            <span className="wb-muted">
              {alt ? `[Image: ${alt}]` : "[Image]"}
            </span>
          ),
          a: ({ href, children }) =>
            /^https?:\/\//i.test(href ?? "") ? (
              <a
                href={href}
                onClick={(event) => {
                  event.preventDefault();
                  if (href) void window.helarc.openExternalLink({ url: href });
                }}
              >
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
          pre: ({ children }) => (
            <div className="wb-code">
              <pre>{children}</pre>
            </div>
          ),
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}
