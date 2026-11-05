'use client'

import * as React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@cosmika/ui'

/**
 * The assistant answers in GitHub-flavoured markdown — headings, bold, lists
 * and, most importantly, tables. Rendering that as preformatted text (which is
 * what the first version of this page did) shows the admin raw pipe characters
 * where a table should be.
 *
 * Raw HTML is deliberately NOT enabled. Model output is not trusted markup:
 * `rehype-raw` here would let anything the model echoed from a tool result —
 * a contact's name, a flow title — become live HTML in the operator console.
 */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="assistant-prose text-sm leading-relaxed" data-testid="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1 className="mb-2 mt-4 text-base font-semibold first:mt-0">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="mb-2 mt-4 text-sm font-semibold first:mt-0">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="mb-1 mt-3 text-sm font-medium first:mt-0">{children}</h3>
          ),
          p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
          ul: ({ children }) => (
            <ul className="mb-2 list-disc space-y-0.5 pl-5 last:mb-0">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="mb-2 list-decimal space-y-0.5 pl-5 last:mb-0">{children}</ol>
          ),
          li: ({ children }) => <li className="pl-0.5">{children}</li>,
          strong: ({ children }) => (
            <strong className="font-semibold text-foreground">{children}</strong>
          ),
          hr: () => <hr className="my-3 border-border" />,
          blockquote: ({ children }) => (
            <blockquote className="my-2 border-l-2 border-border pl-3 text-muted-foreground">
              {children}
            </blockquote>
          ),
          a: ({ href, children }) => (
            <a
              href={href}
              // Model-authored links are untrusted: noopener/noreferrer so the
              // destination can never reach back into this tab.
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="text-primary underline underline-offset-2 hover:opacity-80"
            >
              {children}
            </a>
          ),
          code: ({ className, children }) => {
            // react-markdown gives fenced blocks a language class; inline code
            // has none. Only the block form needs its own scroll container.
            const isBlock = Boolean(className)
            if (!isBlock) {
              return (
                <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
                  {children}
                </code>
              )
            }
            return (
              <code className="block overflow-x-auto whitespace-pre p-3 font-mono text-xs">
                {children}
              </code>
            )
          },
          pre: ({ children }) => (
            <pre className="my-2 overflow-x-auto rounded-md border border-border bg-muted/40">
              {children}
            </pre>
          ),
          // The assistant's most-seen table is this one — model-authored
          // markdown. It goes through the same primitives as every record
          // list, so a GFM table and a data panel look like one product.
          // Table owns the overflow wrapper; the page body never scrolls.
          table: ({ children }) => <Table className="my-2 text-xs">{children}</Table>,
          thead: ({ children }) => <TableHeader>{children}</TableHeader>,
          tbody: ({ children }) => <TableBody>{children}</TableBody>,
          tr: ({ children }) => <TableRow>{children}</TableRow>,
          th: ({ children }) => (
            <TableHead className="h-auto px-2.5 py-1.5">{children}</TableHead>
          ),
          td: ({ children }) => (
            <TableCell className="px-2.5 py-1.5 align-top">{children}</TableCell>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}
