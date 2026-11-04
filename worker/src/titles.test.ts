import { describe, expect, it } from "vitest";
import { otherTitle } from "./titles.js";

const ult = (title: string) => ({
  name: "ULT AddOn [FHD]\n📅 22.09.1994.",
  title: `${title}\n💾 Unknown | 👥 S: 54 | [Nyaa] | 🌐 WEB-DL`,
  infoHash: "a".repeat(40),
});

describe("otherTitle", () => {
  it("flags a scraper's answer for an anime sharing a word with the title asked for (ULT AddOn, Friends)", () => {
    const streams = [
      ult(
        "I Made Friends with the Second Prettiest Girl in My Class S01E01 The Girl Named Asanagi Umi 1080p CR WEB-DL AAC2.0 H 264-VARYG (Class de 2-banme ni Kawaii Onnanoko to Tomodachi ni Natta, Multi-Subs)",
      ),
      ult(
        "[Judas] Class de 2-banme ni Kawaii Onnanoko to Tomodachi ni Natta (I Made Friends with the Second Prettiest Girl in My Class) - S01E01 [1080p][HEVC x265 10bit][Multi-Subs] (Weekly)",
      ),
      ult(
        "Can a Boy-Girl Friendship Survive S01E01 VOSTFR 720p WEB x264 AAC -Tsundere-Raws (CR) (Danjo no Yuujou wa Seiritsu suru? (Iya, Shinai!!))",
      ),
    ];
    expect(otherTitle(streams, ["Friends"])).toEqual({
      streams: [true, true, true],
      title: "I Made Friends with the Second Prettiest Girl in My Class",
    });
  });

  it("keeps dotted release names of the title asked for, even with an episode title and pack words", () => {
    const streams = [
      {
        name: "Torrentio\n1080p",
        title:
          "Friends.S01E01.The.One.Where.Monica.Gets.a.Roommate.1080p.BluRay.x265\n👤 50 💾 300 MB ⚙️ ThePirateBay",
      },
      {
        name: "Torrentio\n4k",
        title: "Friends.Complete.Series.Remastered.2160p\nFriends.S01E01.mkv",
      },
    ];
    expect(otherTitle(streams, ["Friends"])).toBeUndefined();
  });

  it("flags a concert sharing one word with a one-word series title (Internet Archive, Nocturne)", () => {
    const streams = [
      { url: "https://archive.test/a.mp4", title: "Siouxsie and the Banshees - Nocturne (1983)" },
    ];
    expect(otherTitle(streams, ["Nocturne"])?.title).toBe("Siouxsie and the Banshees - Nocturne");
  });

  it("clears the whole answer when one stream names the title asked for", () => {
    const streams = [
      ult("I Made Friends with the Second Prettiest Girl in My Class S01E01 1080p"),
      ult("Friends S01E01 720p HDTV"),
    ];
    expect(otherTitle(streams, ["Friends"])).toBeUndefined();
  });

  it("keeps release names sharing no word with the title, which may give it in another language", () => {
    const streams = [
      { title: "Juego de tronos S01E01 1080p" },
      { title: "Il trono di spade S01E01 720p" },
    ];
    expect(otherTitle(streams, ["Game of Thrones"])).toBeUndefined();
  });

  it("counts those beside a stream naming a longer title sharing a word, but never streams without a release name", () => {
    const streams = [
      ult("You Can't Be In a Rom-Com with Your Childhood Friends! - S01E01 [720p]"),
      ult("Can a Boy-Girl Friendship Survive S01E01 720p"),
      { name: "Addon", title: "1080p\n💾 2 GB", url: "https://cdn.test/a.mp4" },
      {
        name: "Addon",
        description: "Share it with your friends and family",
        url: "https://cdn.test/b.mp4",
      },
    ];
    expect(otherTitle(streams, ["Friends"])?.streams).toEqual([true, true, false, false]);
  });

  it("matches the source's aliases, past a leading release group", () => {
    const streams = [{ title: "[SubsPlease] Shingeki no Kyojin - 01 (1080p) [ABCD1234].mkv" }];
    expect(otherTitle(streams, ["Attack on Titan", "Shingeki no Kyojin", "AoT"])).toBeUndefined();
  });

  it("matches an alternative title in brackets or after a slash", () => {
    const streams = [
      { title: "Le Ali della Libertà (The Shawshank Redemption) 1994 1080p" },
      { title: "Cadena perpetua / The Shawshank Redemption 1994 720p" },
      { title: "Siouxsie and the Banshees Redemption Song Live 1994" },
    ];
    expect(otherTitle(streams, ["The Shawshank Redemption"])).toBeUndefined();
  });

  it("matches an alternative title after a double bar (YouTube Recaps)", () => {
    const streams = [{ title: "قصة سلسلة ذا ماتريكس كاملة || The Matrix 2024" }];
    expect(otherTitle(streams, ["The Matrix"])).toBeUndefined();
  });

  it("matches a localized title that keeps the original beside a subtitle", () => {
    const streams = [{ title: "Breaking Bad - Reazioni collaterali S01E01 1080p" }];
    expect(otherTitle(streams, ["Breaking Bad"])).toBeUndefined();
  });

  it("reads the filename hint as a release name", () => {
    const streams = [
      {
        name: "Addon",
        title: "1080p",
        behaviorHints: { filename: "Siouxsie.and.the.Banshees.Nocturne.1983.mkv" },
      },
    ];
    expect(otherTitle(streams, ["Nocturne"])?.streams).toEqual([true]);
  });

  it("judges nothing without a name for the title", () => {
    expect(
      otherTitle([ult("I Made Friends with the Second Prettiest Girl S01E01")], []),
    ).toBeUndefined();
  });
});
