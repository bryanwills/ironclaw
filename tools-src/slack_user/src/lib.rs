//! Slack personal (user-token) WASM Tool for IronClaw.
//!
//! Unlike the bot-token `slack` tool, this tool authenticates with a Slack
//! **user token** (`xoxp-`) stored under the `slack_user_token` secret, so it
//! acts as the user. That lets it search all of the user's messages, list and
//! read their DMs and group DMs, read channel history, and post as them.
//!
//! # Capabilities Required
//!
//! - HTTP: `slack.com/api/*` (GET, POST)
//! - Secrets: `slack_user_token` (injected automatically as a bearer token)
//!
//! # Supported Actions
//!
//! - `search_messages`: Search all messages the user can see
//! - `list_conversations`: List channels, DMs, and group DMs the user is in
//! - `get_conversation_history`: Read history of any channel or DM
//! - `get_user_info`: Get information about a Slack user
//! - `send_message`: Post a message as the user
//!
//! # Example Usage
//!
//! ```json
//! {"action": "search_messages", "query": "from:@me project plan", "count": 20}
//! ```

mod api;
mod types;

use types::SlackUserAction;

// Generate bindings from the WIT interface.
wit_bindgen::generate!({
    world: "sandboxed-tool",
    path: "../../wit/tool.wit",
});

/// Implementation of the tool interface.
struct SlackUserTool;

impl exports::near::agent::tool::Guest for SlackUserTool {
    fn execute(req: exports::near::agent::tool::Request) -> exports::near::agent::tool::Response {
        match execute_inner(&req.params) {
            Ok(result) => exports::near::agent::tool::Response {
                output: Some(result),
                error: None,
            },
            Err(e) => exports::near::agent::tool::Response {
                output: None,
                error: Some(e),
            },
        }
    }

    fn schema() -> String {
        // Derived from `SlackUserAction` via `schemars::JsonSchema` so the
        // advertised schema can never drift from the serde contract.
        let schema = schemars::schema_for!(types::SlackUserAction);
        serde_json::to_string(&schema).expect("schema serialization is infallible")
    }

    fn description() -> String {
        "Slack personal tool that acts as you via a user token (xoxp-): search all your \
         messages, list and read your DMs and group DMs, read channel history, look up users, \
         and post as you. Requires a Slack user token with scopes such as search:read, \
         channels:history, groups:history, im:history, mpim:history, users:read, and \
         chat:write (for posting)."
            .to_string()
    }
}

/// Inner execution logic with proper error handling.
fn execute_inner(params: &str) -> Result<String, String> {
    // Check that the Slack user token is configured.
    if !crate::near::agent::host::secret_exists("slack_user_token") {
        return Err(
            "Slack user token not configured. Please add the 'slack_user_token' secret \
             (a user OAuth token starting with 'xoxp-')."
                .to_string(),
        );
    }

    let action: SlackUserAction =
        serde_json::from_str(params).map_err(|e| format!("Invalid parameters: {}", e))?;

    crate::near::agent::host::log(
        crate::near::agent::host::LogLevel::Debug,
        &format!("Executing Slack user action: {:?}", action),
    );

    let result = match action {
        SlackUserAction::SearchMessages { query, count, sort } => {
            let result = api::search_messages(&query, count, sort.as_deref())?;
            serde_json::to_string(&result).map_err(|e| e.to_string())?
        }

        SlackUserAction::ListConversations { types, limit } => {
            let result = api::list_conversations(&types, limit)?;
            serde_json::to_string(&result).map_err(|e| e.to_string())?
        }

        SlackUserAction::GetConversationHistory {
            channel,
            limit,
            latest,
            oldest,
        } => {
            let result = api::get_conversation_history(
                &channel,
                limit,
                latest.as_deref(),
                oldest.as_deref(),
            )?;
            serde_json::to_string(&result).map_err(|e| e.to_string())?
        }

        SlackUserAction::GetUserInfo { user_id } => {
            let result = api::get_user_info(&user_id)?;
            serde_json::to_string(&result).map_err(|e| e.to_string())?
        }

        SlackUserAction::SendMessage {
            channel,
            text,
            thread_ts,
        } => {
            let result = api::send_message(&channel, &text, thread_ts.as_deref())?;
            serde_json::to_string(&result).map_err(|e| e.to_string())?
        }
    };

    Ok(result)
}

// Export the tool implementation.
export!(SlackUserTool);
