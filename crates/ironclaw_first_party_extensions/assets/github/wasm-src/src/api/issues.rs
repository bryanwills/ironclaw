use crate::request::github_request;
use crate::validation::*;

pub(crate) fn list_issues(
    owner: &str,
    repo: &str,
    state: Option<&str>,
    page: Option<u32>,
    limit: Option<u32>,
) -> Result<String, String> {
    if !validate_path_segment(owner) || !validate_path_segment(repo) {
        return Err("Invalid owner or repo name".into());
    }
    let state = state.unwrap_or("open");
    let search_state = match state {
        "open" | "closed" => Some(state),
        "all" => None,
        _ => return Err("invalid_state".to_string()),
    };
    validate_search_page(page)?;
    validate_search_limit(limit)?;
    let limit = limit.unwrap_or(30).min(100); // Cap at 100
    let query = build_issue_search_query(
        None,
        None,
        Some(owner),
        Some(repo),
        None,
        None,
        None,
        search_state,
        Some("issue"),
    )?;

    let mut path = format!(
        "/search/issues?q={}&per_page={}",
        url_encode_query(&query),
        limit
    );
    append_search_params(&mut path, page, Some("created"), Some("desc"))?;

    let response = github_request("GET", &path, None)?;
    issue_items_from_search_response(&response)
}

pub(crate) fn issue_items_from_search_response(response: &str) -> Result<String, String> {
    let response: serde_json::Value = serde_json::from_str(response).map_err(|error| {
        format!("github_api_invalid_json: failed to parse issue search response: {error}")
    })?;
    let items = response
        .get("items")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| {
            "github_api_invalid_json: issue search response missing items array".to_string()
        })?;
    serde_json::to_string(items).map_err(|error| {
        format!("github_api_invalid_json: failed to serialize issue search items: {error}")
    })
}

pub(crate) fn create_issue(
    owner: &str,
    repo: &str,
    title: &str,
    body: Option<&str>,
    labels: Option<Vec<String>>,
) -> Result<String, String> {
    if !validate_path_segment(owner) || !validate_path_segment(repo) {
        return Err("Invalid owner or repo name".into());
    }
    validate_input_length(title, "title")?;
    if let Some(b) = body {
        validate_input_length(b, "body")?;
    }
    if let Some(labels) = &labels {
        if labels.len() > 100 {
            return Err("Invalid labels: at most 100 labels are allowed".into());
        }
        for label in labels {
            if label.is_empty() {
                return Err("Invalid labels: labels cannot be empty".into());
            }
            validate_input_length(label, "labels")?;
            if label.chars().count() > 100 {
                return Err(
                    "Invalid labels: label exceeds maximum length of 100 characters".into(),
                );
            }
        }
    }

    let encoded_owner = url_encode_path(owner);
    let encoded_repo = url_encode_path(repo);
    let path = format!("/repos/{}/{}/issues", encoded_owner, encoded_repo);
    let mut req_body = serde_json::json!({
        "title": title,
    });
    if let Some(body) = body {
        req_body["body"] = serde_json::json!(body);
    }
    if let Some(labels) = labels {
        req_body["labels"] = serde_json::json!(labels);
    }
    github_request("POST", &path, Some(req_body.to_string()))
}

pub(crate) fn get_issue(owner: &str, repo: &str, issue_number: u32) -> Result<String, String> {
    if !validate_path_segment(owner) || !validate_path_segment(repo) {
        return Err("Invalid owner or repo name".into());
    }
    let encoded_owner = url_encode_path(owner);
    let encoded_repo = url_encode_path(repo);
    github_request(
        "GET",
        &format!(
            "/repos/{}/{}/issues/{}",
            encoded_owner, encoded_repo, issue_number
        ),
        None,
    )
}

pub(crate) fn list_issue_comments(
    owner: &str,
    repo: &str,
    issue_number: u32,
    page: Option<u32>,
    limit: Option<u32>,
) -> Result<String, String> {
    if !validate_path_segment(owner) || !validate_path_segment(repo) {
        return Err("Invalid owner or repo name".into());
    }
    let encoded_owner = url_encode_path(owner);
    let encoded_repo = url_encode_path(repo);
    let limit = limit.unwrap_or(30).min(100);
    let mut path = format!(
        "/repos/{}/{}/issues/{}/comments?per_page={}",
        encoded_owner, encoded_repo, issue_number, limit
    );
    if let Some(p) = page {
        path.push_str(&format!("&page={}", p));
    }
    github_request("GET", &path, None)
}

pub(crate) fn create_issue_comment(
    owner: &str,
    repo: &str,
    issue_number: u32,
    body: &str,
) -> Result<String, String> {
    if !validate_path_segment(owner) || !validate_path_segment(repo) {
        return Err("Invalid owner or repo name".into());
    }
    validate_input_length(body, "body")?;
    let encoded_owner = url_encode_path(owner);
    let encoded_repo = url_encode_path(repo);
    let path = format!(
        "/repos/{}/{}/issues/{}/comments",
        encoded_owner, encoded_repo, issue_number
    );
    let req_body = serde_json::json!({ "body": body });
    github_request("POST", &path, Some(req_body.to_string()))
}
