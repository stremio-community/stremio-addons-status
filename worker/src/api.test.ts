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

function page(addons: unknown[], nextCursor: string | null) {
  return {
    addons,
    pagination: {
      page: 1,
      limit: 100,
      total: 0,
      totalPages: 0,
      hasNextPage: nextCursor !== null,
      hasPreviousPage: false,
      nextCursor,
    },
  };
}

function stubPages(...pages: unknown[]) {
  const fetchMock = vi.fn();
  for (const body of pages) fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body)));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function requestedUrls(fetchMock: ReturnType<typeof vi.fn>): URL[] {
  return fetchMock.mock.calls.map(([url]) => new URL(url as string));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchAllAddons", () => {
  it("follows each page's cursor in creation order until there is none", async () => {
    const fetchMock = stubPages(
      page([addon("a"), addon("b")], "c1"),
      page([addon("c")], "c2/+="),
      page([addon("d")], null),
    );

    const addons = await fetchAllAddons();

    expect(addons.map((a) => a.uuid)).toEqual(["a", "b", "c", "d"]);
    const urls = requestedUrls(fetchMock);
    for (const url of urls) {
      expect(url.searchParams.get("sort_by")).toBe("createdAt");
      expect(url.searchParams.get("order")).toBe("asc");
      expect(url.searchParams.has("page")).toBe(false);
    }
    expect(urls.map((u) => u.searchParams.get("cursor"))).toEqual([null, "c1", "c2/+="]);
  });

  it("lists instances after their parent, labelled with its name", async () => {
    stubPages(page([addon("a | Host", [addon("a-1")]), addon("b")], null));

    const addons = await fetchAllAddons();

    expect(addons.map((a) => [a.uuid, a.instanceOf])).toEqual([
      ["a | Host", undefined],
      ["a-1", "a"],
      ["b", undefined],
    ]);
  });

  it("fails when a page claims more without a cursor", async () => {
    const body = page([addon("a")], null);
    body.pagination.hasNextPage = true;
    stubPages(body);

    await expect(fetchAllAddons()).rejects.toThrow(/without a cursor/);
  });

  it("fails instead of looping when the API repeats a cursor", async () => {
    stubPages(page([addon("a")], "c1"), page([addon("b")], "c1"));

    await expect(fetchAllAddons()).rejects.toThrow(/repeated cursor/);
  });
});
