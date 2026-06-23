Use `github.rerun_workflow_job` to rerun one GitHub Actions workflow job.

Provide `owner`, `repo`, and `job_id`. Set `enable_debug_logging` or `enable_debugger` only when explicitly needed.

This capability writes to the GitHub API through host HTTP egress and requires a configured GitHub product-auth account.
