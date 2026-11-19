# Upstream pull-request refs

On 2026-11-19 the public Git endpoint for `mksglu/context-mode` advertised 676 numbered pull-request heads and seven merge refs. This snapshot contains their exact Git object IDs. Sort by `number` in the records file to locate a request.

Each `head_commit` identifies the advertised tip. GitHub may generate a `merge_ref_commit` for integration testing. Its presence does not establish that the upstream maintainers merged the request. The total number of PRs ever filed remains unknown.

On the collection date GitHub reported that pull requests were disabled for this repository. For a sample of three advertised numbers (3, 676 and 1302), the pull API and PR pages returned HTTP 404 and the REST issue endpoint returned HTTP 410. GitHub GraphQL, issue search and head-commit PR association did not provide the original PR fields for those numbers. The Git records contain no authors, titles, approval decisions or state.

[PR ref records](pull-refs.json) · [Snapshot manifest](manifest.json) · [Earlier issue snapshot](../2026-11-19/README.md)
