Use `github.get_workflow_run_artifacts` to list artifacts for a GitHub Actions workflow run.

Provide `owner`, `repo`, and `run_id`. Use `name`, `direction`, `limit`, and `page` to narrow results.

This capability reads from the GitHub API through host HTTP egress and requires a configured GitHub product-auth account.
