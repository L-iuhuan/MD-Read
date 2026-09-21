/**
 * 第三方模块类型补齐（仅 Lane A 渲染管线用到的子路径）。
 * 这些入口在包内没有伴随 .d.ts，tsc --strict 下会报 TS7016，故按实际用法补最小声明。
 */
declare module 'markdown-it-emoji/lib/bare.mjs' {
  import type MarkdownIt from 'markdown-it'
  interface EmojiPluginOptions {
    /** 短码 → emoji 字符表，键不含冒号（如 smile → 😄） */
    defs: Record<string, string>
    /** 短码别名 → 主键名；值可为单别名或别名数组（如 smile → [':)', ':-)']） */
    shortcuts: Record<string, string | string[]>
    /** 白名单过滤，空数组表示不过滤 */
    enabled?: string[]
  }
  export default function emojiPlugin(md: MarkdownIt, options?: EmojiPluginOptions): void
}

declare module 'markdown-it-footnote' {
  import type MarkdownIt from 'markdown-it'
  const footnotePlugin: (md: MarkdownIt) => void
  export default footnotePlugin
}

declare module 'katex/contrib/auto-render' {
  interface MathDelimiter {
    left: string
    right: string
    display: boolean
  }
  interface AutoRenderOptions {
    delimiters?: MathDelimiter[]
    ignoredTags?: string[]
    ignoredClasses?: string[]
    errorCallback?: (msg: string, err: Error) => void
    macros?: Record<string, string>
  }
  export default function renderMathInElement(elem: HTMLElement, options?: AutoRenderOptions): void
}

declare module 'highlight.js/lib/languages/*' {
  import type { LanguageFn } from 'highlight.js'
  const language: LanguageFn
  export default language
}
