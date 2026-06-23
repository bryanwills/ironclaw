Use `github.update_pull_request` to update pull request metadata.

Provide `owner`, `repo`, and `pr_number`. Include only the fields that should change: `title`, `body`, `state`, `base`, or `maintainer_can_modify`.

This capability writes to the GitHub API through host HTTP egress and requires a configured GitHub product-auth account.
