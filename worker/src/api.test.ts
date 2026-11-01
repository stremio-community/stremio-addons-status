import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAllAddons } from "./api.js";

function addon(uuid: string, instances: unknown[] = []) {
  return {
    uuid,
    url: `https://${uuid}.example.org`,
    manifestUrl: `https://${uuid}.example.org/manifest.json`,
    manifest: { name: uuid },
    slug: uuid,
    stars: 0,
    instances,
  };
}

function page(page: number, totalPages: number, addons: unknown[]) {
  return {
    addons,
    pagination: {
      page,
      limit: 100,
      total: 0,
      totalPages,
      hasNextPage: page < totalPages,
      hasPreviousPage: page > 1,
    },
  };
}

function stubPages(...pages: unknown[]) {
  const fetchMock = vi.fn();
  for (const body of pages) fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body)));
  vi.stubGlobal("fetch", fetchMock);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchAllAddons", () => {
  it("lists an addon once when the list shifts between pages and it shows up on both", async () => {
    stubPages(page(1, 2, [addon("a"), addon("b")]), page(2, 2, [addon("b"), addon("c")]));

    const addons = await fetchAllAddons();

    expect(addons.map((a) => a.uuid)).toEqual(["a", "b", "c"]);
  });

  it("lists an instance once when its parent shows up on two pages", async () => {
    stubPages(
      page(1, 2, [addon("a", [addon("a-1")])]),
      page(2, 2, [addon("a", [addon("a-1")]), addon("b")]),
    );

    const addons = await fetchAllAddons();

    expect(addons.map((a) => a.uuid)).toEqual(["a", "a-1", "b"]);
  });
});
