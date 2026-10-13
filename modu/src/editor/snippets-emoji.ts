/**
 * 常用 emoji 三元组（fix-27 数据源归一）：编辑器候选与渲染侧白名单同源。
 *
 * 事实源是 src/render/markdown.ts 的 EMOJI_DEFS（61 键）——渲染只认它，编辑器
 * 候选超出它就是「补得出、渲染不出」。markdown.ts 不在本批可改清单、无法 export，
 * 故逐键抄录（键序同源、emoji 逐字一致），漂移由 tests/snippets.spec.ts 的对齐锚
 * 兜底：两文件键集相等＋emoji 本体逐键一致，任一侧改动不同步即红。
 * 中文标注沿袭 fix-26 旧表（同 emoji 保留原标注），新键补短标注。
 * shortcode 限 ASCII 词字符＋加减（触发正则 [\w+-] 的过滤域），label 形如 `:smile:`。
 * 仅数据，无行为；菜单逻辑在 snippets.ts 的 emoji 源分支。
 */
export interface EmojiEntry {
  readonly code: string;
  readonly emoji: string;
  readonly zh: string;
}

/** 键集与 emoji 本体 = markdown.ts EMOJI_DEFS（同序抄录；对齐锚见 tests/snippets.spec.ts） */
export const EMOJI_ENTRIES: readonly EmojiEntry[] = [
  // 笑与哭
  { code: "smile", emoji: "😄", zh: "笑" },
  { code: "smiley", emoji: "😃", zh: "微笑" },
  { code: "grin", emoji: "😁", zh: "露齿笑" },
  { code: "joy", emoji: "😂", zh: "笑哭" },
  { code: "rofl", emoji: "🤣", zh: "打滚笑" },
  { code: "laughing", emoji: "😆", zh: "大笑" },
  { code: "wink", emoji: "😉", zh: "眨眼" },
  { code: "blush", emoji: "😊", zh: "害羞笑" },
  { code: "heart_eyes", emoji: "😍", zh: "花痴" },
  { code: "kiss", emoji: "😘", zh: "飞吻" },
  { code: "sweat_smile", emoji: "😅", zh: "尴尬笑" },
  { code: "cry", emoji: "😢", zh: "哭" },
  { code: "sob", emoji: "😭", zh: "大哭" },
  // 情绪
  { code: "thinking", emoji: "🤔", zh: "思考" },
  { code: "neutral_face", emoji: "😐", zh: "无表情" },
  { code: "expressionless", emoji: "😑", zh: "无语" },
  { code: "confused", emoji: "😕", zh: "困惑" },
  { code: "angry", emoji: "😠", zh: "生气" },
  { code: "rage", emoji: "😡", zh: "怒" },
  { code: "scream", emoji: "😱", zh: "尖叫" },
  { code: "sleeping", emoji: "😴", zh: "睡觉" },
  // 手势
  { code: "+1", emoji: "👍", zh: "赞" },
  { code: "thumbsup", emoji: "👍", zh: "赞" },
  { code: "-1", emoji: "👎", zh: "踩" },
  { code: "thumbsdown", emoji: "👎", zh: "踩" },
  { code: "ok_hand", emoji: "👌", zh: "OK" },
  { code: "clap", emoji: "👏", zh: "鼓掌" },
  { code: "pray", emoji: "🙏", zh: "感谢/祈祷" },
  { code: "muscle", emoji: "💪", zh: "加油" },
  { code: "wave", emoji: "👋", zh: "挥手" },
  { code: "point_right", emoji: "👉", zh: "指右" },
  { code: "eyes", emoji: "👀", zh: "眼睛" },
  // 符号
  { code: "star", emoji: "⭐", zh: "星" },
  { code: "sparkles", emoji: "✨", zh: "闪" },
  { code: "fire", emoji: "🔥", zh: "火/热门" },
  { code: "tada", emoji: "🎉", zh: "庆祝" },
  { code: "bulb", emoji: "💡", zh: "想法" },
  { code: "warning", emoji: "⚠️", zh: "警告" },
  { code: "question", emoji: "❓", zh: "问" },
  { code: "white_check_mark", emoji: "✅", zh: "勾" },
  { code: "x", emoji: "❌", zh: "叉" },
  { code: "heart", emoji: "❤️", zh: "红心" },
  { code: "broken_heart", emoji: "💔", zh: "心碎" },
  { code: "100", emoji: "💯", zh: "满分" },
  { code: "rocket", emoji: "🚀", zh: "火箭/上线" },
  // 工作与生活
  { code: "coffee", emoji: "☕", zh: "咖啡" },
  { code: "cake", emoji: "🍰", zh: "蛋糕" },
  { code: "calendar", emoji: "📅", zh: "日期" },
  { code: "memo", emoji: "📝", zh: "备忘" },
  { code: "book", emoji: "📖", zh: "书" },
  { code: "email", emoji: "📧", zh: "邮件" },
  { code: "phone", emoji: "📱", zh: "手机" },
  { code: "computer", emoji: "💻", zh: "电脑" },
  { code: "lock", emoji: "🔒", zh: "锁" },
  { code: "key", emoji: "🔑", zh: "钥匙" },
  { code: "chart_with_upwards_trend", emoji: "📈", zh: "涨" },
  { code: "chart_with_downwards_trend", emoji: "📉", zh: "跌" },
  { code: "dart", emoji: "🎯", zh: "目标" },
  { code: "money_with_wings", emoji: "💸", zh: "飞钱" },
  { code: "dollar", emoji: "💵", zh: "美元" },
  { code: "yen", emoji: "💴", zh: "日元" },
];
