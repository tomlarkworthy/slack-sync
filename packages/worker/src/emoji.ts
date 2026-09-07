// Slack emoji short names <-> unicode, both directions. Forward needs
// name -> unicode (Slack reaction events carry names); reverse needs
// unicode -> name (reactions.add wants `name=heart`, never the character).
import { aliases as EMOJI_ALIASES, entries as EMOJI_ENTRIES } from "./emoji-data";

export const EMOJI_MAP = new Map<string, string>();
export const EMOJI_NAME_MAP = new Map<string, string>();
for (const [name, unicode] of EMOJI_ENTRIES as Array<[string, string]>) {
  EMOJI_MAP.set(name, unicode);
  if (!EMOJI_NAME_MAP.has(unicode)) EMOJI_NAME_MAP.set(unicode, name);
}
for (const [name, unicode] of Object.entries(EMOJI_ALIASES)) {
  EMOJI_MAP.set(name, unicode as string);
  if (!EMOJI_NAME_MAP.has(unicode as string)) EMOJI_NAME_MAP.set(unicode as string, name);
}

export function emojiForName(name: string): string {
  const base = name.split("::")[0]!;
  return EMOJI_MAP.get(base) ?? `:${name}:`;
}

const VS16 = "️";
// Colibri stores the character (💜) or, for custom emoji, the bridge's `:name:`
// form. Returns undefined when Slack has no short name for it.
export function emojiNameFor(emoji: string): string | undefined {
  const custom = /^:([a-z0-9_+-]+):$/i.exec(emoji);
  if (custom) return custom[1];
  return (
    EMOJI_NAME_MAP.get(emoji) ??
    EMOJI_NAME_MAP.get(emoji.replaceAll(VS16, "")) ??
    EMOJI_NAME_MAP.get(emoji + VS16)
  );
}
