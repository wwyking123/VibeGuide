/** Text selected in the main conversation, carried into a sidebar question as quoted material. */
export const DEFAULT_QUESTION = '这是什么意思？';
const MAX_QUOTE = 1200;
// Invisible control and formatting characters: they add nothing a person selected on purpose.
const INVISIBLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g;

export const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1)}…` : text;

export function cleanSelection(raw: string): string {
  return clip(raw.replace(/\r\n?|[\u2028\u2029]/g, '\n').replace(INVISIBLE, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(), MAX_QUOTE);
}

/** A leading 「 also keeps the sidebar from reading a quoted "请修改…" as the owner's own instruction. */
export const quoteStatement = (quote: string, question: string) => `「${quote}」\n\n${question.trim() || DEFAULT_QUESTION}`;

export function splitQuote(statement: string): { quote: string; question: string } | undefined {
  const end = statement.lastIndexOf('」\n\n');
  if (!statement.startsWith('「') || end < 1) return undefined;
  const question = statement.slice(end + 3).trim();
  return question ? { quote: statement.slice(1, end), question } : undefined;
}
