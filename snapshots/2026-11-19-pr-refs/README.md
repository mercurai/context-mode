# Upstream pull-request refs

On 2026-11-19 the public Git endpoint for `mksglu/context-mode` advertised 676 numbered pull-request heads and seven merge refs. This snapshot contains their exact Git object IDs. Sort by `number` in the records file to locate a request.

Each `head_commit` identifies the advertised tip. GitHub may generate a `merge_ref_commit` for integration testing. Its presence does not establish that the upstream maintainers merged the request. The total number of PRs ever filed remains unknown.

On the collection date GitHub reported that pull requests were disabled for this repository. For a sample of three advertised numbers (3, 676 and 1302), the pull API and PR pages returned HTTP 404 and the REST issue endpoint returned HTTP 410. GitHub GraphQL, issue search and head-commit PR association did not provide the original PR fields for those numbers. The Git records contain no authors, titles, approval decisions or state.

[PR ref records](pull-refs.json) · [Snapshot manifest](manifest.json) · [Earlier issue snapshot](../2026-11-19/README.md)

## Public event observations

The public ClickHouse GitHub events dataset yielded 103 dated observations for 89 of the 676 numbered requests. They include 60 opening events, nine closing events, 15 merge events, ten review creations and nine review-comment creations. The observed activity runs from March 5 through October 12, 2026 UTC. The remaining 587 numbers appear only in the Git ref inventory in this comparison.

The actor and time belong to the individual event. The dataset did not supply PR authors, titles, object-level timestamps or current PR state for the lifecycle records. The ten review events contain two observed approvals, three requests for changes and five commented reviews. These describe individual reviews. The nine public comment IDs distinguish comments recorded at the same timestamp. The archive stores these fields alongside the public event type or action, PR number, time and actor handle.

[Lifecycle observations](public-pr-events.json) · [Review observations](public-pr-review-events.json) · [Event manifest](public-pr-events-manifest.json) · [Public dataset](https://clickhouse.com/demos/explore-github-with-clickhouse-powered-real-time-analytics)
