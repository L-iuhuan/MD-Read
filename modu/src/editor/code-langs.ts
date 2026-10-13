/**
 * 围栏代码语言精选表（自 editor.ts 外移，编辑增强 B1 腾 500 行棘轮——手法同 phrases.ts 先例）。
 * 七项懒加载；无 lang-typescript，ts 复用 lang-javascript。
 */
import { LanguageDescription } from "@codemirror/language";

export const CODE_LANGUAGES: LanguageDescription[] = [
  LanguageDescription.of({ name: "typescript", alias: ["ts"], load: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ typescript: true })) }),
  LanguageDescription.of({ name: "javascript", alias: ["js"], load: () => import("@codemirror/lang-javascript").then((m) => m.javascript()) }),
  LanguageDescription.of({ name: "python", alias: ["py"], load: () => import("@codemirror/lang-python").then((m) => m.python()) }),
  LanguageDescription.of({ name: "json", load: () => import("@codemirror/lang-json").then((m) => m.json()) }),
  LanguageDescription.of({ name: "rust", alias: ["rs"],
    load: () => import("@codemirror/lang-rust").then((m) => m.rust()) }),
  LanguageDescription.of({ name: "html",
    load: () => import("@codemirror/lang-html").then((m) => m.html()) }),
  LanguageDescription.of({ name: "css",
    load: () => import("@codemirror/lang-css").then((m) => m.css()) }),
];
