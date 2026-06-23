Use `github.resolve_review_thread` to mark an inline pull request review thread as resolved.

Provide the GraphQL review `thread_id` from `github.list_pull_request_review_threads`.

Use the exact JSON field names from this capability schema. If the user provides a GitHub URL, extract the owner and repo fields plus the schema-specific number, path, or ref key; for pull-request tools, use `pr_number`; for issue tools, use `issue_number`.

This capability writes to the GitHub GraphQL API through host HTTP egress and requires a configured GitHub product-auth account.
