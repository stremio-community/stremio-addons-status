/** The parts of a meta that decide which video Stremio requests streams for. */
export interface PlayableMeta {
  id: string;
  type?: string;
  videos?: Array<{ id: string; season?: number; episode?: number }>;
  behaviorHints?: { defaultVideoId?: string };
}

/**
 * The ID Stremio requests streams with for this meta, whatever its type.
 * A meta naming a `defaultVideoId` plays that video; one without other videos plays as a single item under its own ID.
 * Otherwise it is the first regular episode, since season 0 holds specials that many addons have no streams for.
 */
export function streamIdForMeta(meta: PlayableMeta): string {
  const defaultVideoId = meta.behaviorHints?.defaultVideoId;
  if (defaultVideoId) return defaultVideoId;
  const videos = (meta.videos ?? []).filter((v) => v.id && v.id !== meta.id);
  if (videos.length === 0) return meta.id;
  const regular = videos
    .filter((v) => typeof v.season === "number" && v.season >= 1)
    .sort((a, b) => a.season! - b.season! || (a.episode ?? 0) - (b.episode ?? 0));
  return (regular[0] ?? videos[0]).id;
}
