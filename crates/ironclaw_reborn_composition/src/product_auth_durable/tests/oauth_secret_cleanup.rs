use super::*;

// ─── fix: abbyshekit review — OAuth CAS-conflict branch purges old secrets ───

#[tokio::test]
async fn filesystem_oauth_cas_conflict_branch_purges_previous_secrets() {
    // When the None-path CAS-conflict branch re-reads and overwrites an existing
    // account, the previous access/refresh secret handles must be deleted from
    // SecretStore so repeated re-auths do not accumulate dead handles.
    use ironclaw_auth::ProviderCallbackOutcome;
    use ironclaw_secrets::SecretMaterial;

    let filesystem = test_filesystem();
    let concrete_secret_store = Arc::new(InMemorySecretStore::new());
    let secret_store: Arc<dyn SecretStore> = concrete_secret_store.clone();
    let scope = test_scope();
    let service = test_service(Arc::clone(&filesystem), Arc::clone(&secret_store));

    let flow = service
        .create_flow(NewAuthFlow {
            scope: scope.clone(),
            kind: AuthFlowKind::IntegrationCredential,
            provider: google_provider(),
            challenge: AuthChallenge::OAuthUrl {
                authorization_url: OAuthAuthorizationUrl::new("https://provider.example/oauth")
                    .unwrap(),
                expires_at: Utc::now() + Duration::minutes(5),
            },
            continuation: AuthContinuationRef::SetupOnly,
            update_binding: None,
            opaque_state_hash: Some(state_hash("cas-s")),
            pkce_verifier_hash: Some(pkce_hash("cas-p")),
            expires_at: Utc::now() + Duration::minutes(5),
        })
        .await
        .unwrap();

    // Pre-seed the account with old secrets.
    let preseeded_id = CredentialAccountId::from_uuid(flow.id.as_uuid());
    let old_access = SecretHandle::new("old-access").unwrap();
    let old_refresh = SecretHandle::new("old-refresh").unwrap();
    concrete_secret_store
        .put(
            scope.resource.clone(),
            old_access.clone(),
            SecretMaterial::from("old-access-token"),
        )
        .await
        .unwrap();
    concrete_secret_store
        .put(
            scope.resource.clone(),
            old_refresh.clone(),
            SecretMaterial::from("old-refresh-token"),
        )
        .await
        .unwrap();

    service
        .create_account_with_id(
            preseeded_id,
            NewCredentialAccount {
                scope: scope.clone(),
                provider: google_provider(),
                label: account_label(),
                status: CredentialAccountStatus::Configured,
                ownership: CredentialOwnership::UserReusable,
                owner_extension: None,
                granted_extensions: vec![],
                access_secret: Some(old_access.clone()),
                refresh_secret: Some(old_refresh.clone()),
                scopes: vec![],
            },
            CasExpectation::Absent,
        )
        .await
        .unwrap();

    service
        .claim_oauth_callback(
            &scope,
            OAuthCallbackClaimRequest {
                flow_id: flow.id,
                opaque_state_hash: state_hash("cas-s"),
                provider: google_provider(),
                pkce_verifier_hash: pkce_hash("cas-p"),
            },
        )
        .await
        .unwrap();

    let new_access = SecretHandle::new("new-access").unwrap();
    let new_refresh = SecretHandle::new("new-refresh").unwrap();
    let completed = service
        .complete_oauth_callback(
            &scope,
            OAuthCallbackInput {
                flow_id: flow.id,
                opaque_state_hash: state_hash("cas-s"),
                outcome: ProviderCallbackOutcome::Authorized {
                    exchange: OAuthProviderExchange {
                        provider: google_provider(),
                        account_label: account_label(),
                        authorization_code_hash: code_hash("cas-c"),
                        pkce_verifier_hash: pkce_hash("cas-p"),
                        access_secret: new_access.clone(),
                        refresh_secret: Some(new_refresh.clone()),
                        scopes: vec![ProviderScope::new("gmail.readonly").unwrap()],
                        account_id: None,
                    },
                },
            },
        )
        .await
        .unwrap();

    assert_eq!(
        completed.credential_account_id,
        Some(preseeded_id),
        "CAS-conflict branch must reuse pre-seeded account"
    );

    // Old secrets must be purged from SecretStore.
    assert!(
        concrete_secret_store
            .metadata(&scope.resource, &old_access)
            .await
            .unwrap()
            .is_none(),
        "old access secret must be purged after CAS-conflict update"
    );
    assert!(
        concrete_secret_store
            .metadata(&scope.resource, &old_refresh)
            .await
            .unwrap()
            .is_none(),
        "old refresh secret must be purged after CAS-conflict update"
    );
}
