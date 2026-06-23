Use `github.update_issue` to update an issue or pull request issue record.

Provide `owner`, `repo`, and `issue_number`. Include only the fields that should change: `title`, `body`, `state`, `milestone`, `labels`, or `assignees`.

This capability writes to the GitHub API through host HTTP egress and requires a configured GitHub product-auth account.
