Use `github.list_pull_request_review_threads` to list inline review threads on a pull request.

Provide `owner`, `repo`, and `pr_number`. Use `first` and `after` for GraphQL cursor pagination when needed.

Use the exact JSON field names from this capability schema. If the user provides a GitHub URL, extract the owner and repo fields plus the schema-specific number, path, or ref key; for pull-request tools, use `pr_number`; for issue tools, use `issue_number`.

This capability reads from the GitHub GraphQL API through host HTTP egress and requires a configured GitHub product-auth account.
