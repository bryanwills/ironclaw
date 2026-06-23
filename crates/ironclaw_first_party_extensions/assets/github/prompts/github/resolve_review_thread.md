Use `github.resolve_review_thread` to mark an inline pull request review thread as resolved.

Provide the GraphQL review `thread_id` from `github.list_pull_request_review_threads`.

This capability writes to the GitHub GraphQL API through host HTTP egress and requires a configured GitHub product-auth account.
