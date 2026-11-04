/**
 * How a stream's release names fit the title asked for.
 * `match`: one names it; `other`: one shares a word with it but names a longer title, as a scraper's fuzzy search returns; `unrelated`: release names sharing no word, which a localized title does too; `untitled`: no release name to tell by.
 */
type Fit = "match" | "other" | "unrelated" | "untitled";

const FIT_RANK: Record<Fit, number> = { match: 3, other: 2, unrelated: 1, untitled: 0 };

/** What ends the title in a release name: an episode, season, year, resolution, source, codec or file extension. */
const MARKER = new RegExp(
  [
    String.raw`\bs\d{1,2} ?e\d{1,4}\b`,
    String.raw`\bs\d{1,2}\b`,
    String.raw`\b\d{1,2}x\d{2,3}\b`,
    String.raw`\be(p|pisode)? ?\d{1,4}\b`,
    String.raw`\b(season|temporada|stagione|saison|staffel|complete)\b`,
    String.raw`\b(19|20)\d{2}\b`,
    String.raw`\b(480|576|720|1080|1440|2160|4320)[pi]\b`,
    String.raw`\b[48]k\b`,
    String.raw`\buhd\b`,
    String.raw`\b(blu-?ray|bd(rip)?|br(rip)?|web(-?dl|-?rip)?|hdtv|dvd(rip)?|hdrip|remux|x26[45]|h ?26[45]|hevc|avc)\b`,
    String.raw`\b(mkv|mp4|avi|m4v|webm)\b`,
    String.raw`\s-\s\d{1,4}\b`,
  ].join("|"),
  "iu",
);

/** Release groups lead a release name in brackets: `[SubsPlease] …`. */
const LEADING_GROUPS = /^\s*(?:[[【][^\]】]*[\]】]\s*)+/u;

/** Alternative titles sit in brackets, after a bar, or after a slash between spaces (AC/DC is one title). */
const ALTERNATIVES = /[()[\]{}|]|\s\/+\s/u;

/** Words that don't tell titles apart: articles, prepositions and particles in the languages release names use, and release tags left before the first marker. */
const IGNORED = new Set([
  ...[
    "the",
    "an",
    "of",
    "and",
    "in",
    "on",
    "at",
    "to",
    "for",
    "with",
    "from",
    "by",
    "my",
    "your",
    "is",
    "it",
    "its",
    "as",
    "or",
  ],
  ...[
    "el",
    "la",
    "los",
    "las",
    "de",
    "del",
    "en",
    "un",
    "una",
    "il",
    "lo",
    "gli",
    "le",
    "di",
    "da",
    "della",
    "dei",
    "delle",
  ],
  ...[
    "les",
    "du",
    "des",
    "et",
    "une",
    "der",
    "die",
    "das",
    "und",
    "ein",
    "eine",
    "os",
    "do",
    "dos",
  ],
  ...["no", "wa", "ga", "ni", "wo"],
  ...[
    "multi",
    "subs",
    "sub",
    "dub",
    "dubbed",
    "dual",
    "audio",
    "vostfr",
    "vost",
    "ita",
    "eng",
    "esp",
    "spa",
    "lat",
  ],
  ...[
    "proper",
    "repack",
    "internal",
    "limited",
    "extended",
    "remastered",
    "uncut",
    "unrated",
    "directors",
    "cut",
  ],
  ...["edition", "imax", "hdr", "hdr10", "dv", "10bit", "collection", "pack", "vol", "raw", "raws"],
]);

function words(text: string): Set<string> {
  return new Set(
    text
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 1 && !/^\d+$/.test(w) && !IGNORED.has(w)),
  );
}

interface Named {
  fit: Fit;
  /** The title a release name gives, when it fits as `other`. */
  title?: string;
}

function fitOf(title: Set<string>, names: readonly Set<string>[]): Fit {
  if (title.size === 0) return "untitled";
  let shared = false;
  for (const name of names) {
    const overlap = [...title].filter((w) => name.has(w)).length;
    if (overlap * 2 >= name.size && overlap * 2 >= title.size) return "match";
    shared ||= overlap > 0;
  }
  return shared ? "other" : "unrelated";
}

/** The titles a line names when it reads as a release name: the text before its first marker, past any release group. */
function releaseTitles(line: string): string[] {
  const text = line.replace(/[._]/g, " ").replace(LEADING_GROUPS, "");
  const marker = MARKER.exec(text);
  if (!marker) return [];
  return text
    .slice(0, marker.index)
    .split(ALTERNATIVES)
    .map((t) => t.replace(/\s+/g, " ").replace(/^[\s\-–:]+|[\s\-–:]+$/g, ""))
    .filter((t) => t !== "");
}

function streamLines(s: unknown): string[] {
  if (!s || typeof s !== "object") return [];
  const obj = s as Record<string, unknown>;
  const hints = obj.behaviorHints as Record<string, unknown> | undefined;
  return [obj.name, obj.title, obj.description, hints?.filename]
    .filter((v): v is string => typeof v === "string")
    .flatMap((v) => v.split(/\r?\n/));
}

function namedBy(s: unknown, names: readonly Set<string>[]): Named {
  let best: Named = { fit: "untitled" };
  for (const title of streamLines(s).flatMap(releaseTitles)) {
    const fit = fitOf(words(title), names);
    if (FIT_RANK[fit] > FIT_RANK[best.fit]) best = { fit, ...(fit === "other" ? { title } : {}) };
  }
  return best;
}

export interface OtherTitle {
  /** Per stream of the answer, whether it names the other title. */
  streams: boolean[];
  /** The other title, as the first stream naming it gives it. */
  title: string;
}

/**
 * Whether an answer's streams are for another title than the one known by `names`, as a scraper whose search matched the wrong title answers.
 * One stream naming the title clears the whole answer, since a search returns one title's releases; so does an answer without any stream sharing a word with it but naming a longer title.
 * Release names sharing no word with the title count only beside such a stream, since on their own they may give the title in another language.
 */
export function otherTitle(
  streams: readonly unknown[],
  names: readonly string[],
): OtherTitle | undefined {
  const nameWords = names.map(words).filter((n) => n.size > 0);
  if (nameWords.length === 0) return undefined;
  const named = streams.map((s) => namedBy(s, nameWords));
  if (named.some((n) => n.fit === "match")) return undefined;
  const title = named.find((n) => n.fit === "other")?.title;
  if (title === undefined) return undefined;
  return { streams: named.map((n) => n.fit === "other" || n.fit === "unrelated"), title };
}
