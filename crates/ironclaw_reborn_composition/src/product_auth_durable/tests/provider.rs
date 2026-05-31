use super::*;

// ─── UnavailableAuthProviderClient validates before returning error ───────────

#[tokio::test]
async fn unavailable_auth_provider_client_validates_before_returning_backend_unavailable() {
    use super::provider::UnavailableAuthProviderClient;
    use ironclaw_auth::{
        AuthProviderClient, OAuthAuthorizationCode, OAuthProviderCallbackRequest,
        OAuthProviderExchangeContext, OAuthProviderRefreshRequest,
    };
    use secrecy::SecretString;

    let client = UnavailableAuthProviderClient;

    let ctx = OAuthProviderExchangeContext {
        scope: test_scope(),
        flow_id: ironclaw_auth::AuthFlowId::new(),
    };

    // Valid request must return BackendUnavailable (no provider configured) after
    // the internal validate_provider_callback_request guard passes.
    let valid = OAuthProviderCallbackRequest {
        provider: google_provider(),
        account_label: account_label(),
        authorization_code: OAuthAuthorizationCode::new(SecretString::from("real-code")).unwrap(),
        authorization_code_hash: code_hash("c"),
        pkce_verifier: ironclaw_auth::PkceVerifierSecret::new(SecretString::from("real-verifier"))
            .unwrap(),
        pkce_verifier_hash: pkce_hash("p"),
        scopes: vec![],
    };
    let err = client.exchange_callback(ctx, valid).await.unwrap_err();
    assert_eq!(
        err,
        AuthProductError::BackendUnavailable,
        "valid request must reach BackendUnavailable (no provider configured)"
    );

    // 3. refresh_token always BackendUnavailable.
    let refresh_err = client
        .refresh_token(OAuthProviderRefreshRequest {
            scope: test_scope(),
            account_id: CredentialAccountId::new(),
            provider: google_provider(),
            refresh_secret: SecretHandle::new("r").unwrap(),
            scopes: vec![],
        })
        .await
        .unwrap_err();
    assert_eq!(refresh_err, AuthProductError::BackendUnavailable);
}
