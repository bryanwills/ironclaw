Use `github.rerun_failed_workflow_run_jobs` to rerun only failed jobs in a GitHub Actions workflow run.

Provide `owner`, `repo`, and `run_id`. Set `enable_debug_logging` only when explicitly needed.

This capability writes to the GitHub API through host HTTP egress and requires a configured GitHub product-auth account.
