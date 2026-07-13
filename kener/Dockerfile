# Kener with one patch on top of the pinned upstream image.
#
# Kener's /dashboard-apis/monitor-bars batch endpoint caps a request at 100 tags, but its own
# frontend fetches ALL of a page's monitors in a single batch — our home page holds ~540, so every
# monitor bar failed to render. Raise the compiled server-side cap until upstream chunks the
# client-side batches.
#
# The grep guard makes the build fail loudly if the pattern disappears in a future Kener version,
# so a version bump can't silently reintroduce the bug.
FROM rajnandan1/kener:v4.1.2

RUN set -e; \
    files=$(grep -rl "const MAX_TAGS = 100;" /app/build/server/chunks); \
    sed -i "s/const MAX_TAGS = 100;/const MAX_TAGS = 1000;/" $files; \
    grep -rq "const MAX_TAGS = 1000;" /app/build/server/chunks
