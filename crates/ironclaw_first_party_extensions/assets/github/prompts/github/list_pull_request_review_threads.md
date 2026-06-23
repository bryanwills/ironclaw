Use `github.list_pull_request_review_threads` to list inline review threads on a pull request.

Provide `owner`, `repo`, and `pr_number`. Use `first` and `after` for GraphQL cursor pagination when needed.

This capability reads from the GitHub GraphQL API through host HTTP egress and requires a configured GitHub product-auth account.
