/**
 * Name used in the dashboard greeting ("Assalamu'alaikum, <name>").
 *
 * Takes the first word of the full name that is not an initial or an
 * abbreviated title, so "M. Rahman Hakim" greets "Rahman" instead
 * of "M.". Falls back to the whole name when every word is abbreviated.
 */
export function greetingName(fullName: string | null | undefined, fallback = "Pegawai"): string {
  const words = (fullName ?? "").split(/\s+/).filter(Boolean);
  if (words.length === 0) return fallback;
  const isAbbreviation = (word: string) => word.endsWith(".") || /^\p{L}$/u.test(word);
  return words.find((word) => !isAbbreviation(word)) ?? words.join(" ");
}
