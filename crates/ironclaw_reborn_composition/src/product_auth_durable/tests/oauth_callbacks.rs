use super::*;

#[tokio::test]
async fn filesystem_oauth_callback_claim_is_one_shot_and_completion_persists() {
    let filesystem = test_filesystem();
    let secret_store: Arc<dyn SecretStore> = Arc::new(InMemorySecretStore::new());
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
            opaque_state_hash: Some(state_hash("state")),
            pkce_verifier_hash: Some(pkce_hash("pkce")),
            expires_at: Utc::now() + Duration::minutes(5),
        })
        .await
        .unwrap();
    let claim = OAuthCallbackClaimRequest {
        flow_id: flow.id,
        opaque_state_hash: state_hash("state"),
        provider: google_provider(),
        pkce_verifier_hash: pkce_hash("pkce"),
    };

    let claimed = service
        .claim_oauth_callback(&scope, claim.clone())
        .await
        .unwrap();
    assert_eq!(claimed.status, AuthFlowStatus::CallbackReceived);

    let second_claim = service
        .claim_oauth_callback(&scope, claim.clone())
        .await
        .expect_err("in-flight callback claim must be one-shot");
    assert_eq!(second_claim, AuthProductError::FlowAlreadyTerminal);

    let completed = service
        .complete_oauth_callback(
            &scope,
            OAuthCallbackInput {
                flow_id: flow.id,
                opaque_state_hash: state_hash("state"),
                outcome: ironclaw_auth::ProviderCallbackOutcome::Authorized {
                    exchange: OAuthProviderExchange {
                        provider: google_provider(),
                        account_label: account_label(),
                        authorization_code_hash: code_hash("code"),
                        pkce_verifier_hash: pkce_hash("pkce"),
                        access_secret: SecretHandle::new("oauth-access").unwrap(),
                        refresh_secret: Some(SecretHandle::new("oauth-refresh").unwrap()),
                        scopes: vec![ProviderScope::new("gmail.readonly").unwrap()],
                        account_id: None,
                    },
                },
            },
        )
        .await
        .unwrap();
    assert_eq!(completed.status, AuthFlowStatus::Completed);
    assert!(completed.credential_account_id.is_some());

    let emitted_at = Utc::now();
    service
        .mark_continuation_dispatched(&scope, flow.id, emitted_at)
        .await
        .unwrap();

    let recreated = test_service(Arc::clone(&filesystem), secret_store);
    let stored = recreated
        .get_flow(&scope, flow.id)
        .await
        .unwrap()
        .expect("completed flow should be durable");
    assert_eq!(stored.status, AuthFlowStatus::Completed);
    assert_eq!(stored.continuation_emitted_at, Some(emitted_at));

    let completed_replay = recreated
        .claim_oauth_callback(&scope, claim)
        .await
        .expect("completed callback replay should not reclaim provider exchange");
    assert_eq!(completed_replay.status, AuthFlowStatus::Completed);
    assert_eq!(completed_replay.continuation_emitted_at, Some(emitted_at));
}

// ─── fix: mark_continuation_dispatched is idempotent ─────────────────────────

#[tokio::test]
async fn filesystem_oauth_continuation_marker_is_idempotent() {
    let filesystem = test_filesystem();
    let secret_store: Arc<dyn SecretStore> = Arc::new(InMemorySecretStore::new());
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
            opaque_state_hash: Some(state_hash("s")),
            pkce_verifier_hash: Some(pkce_hash("p")),
            expires_at: Utc::now() + Duration::minutes(5),
        })
        .await
        .unwrap();

    // Complete the flow so mark_continuation_dispatched is valid.
    service
        .claim_oauth_callback(
            &scope,
            OAuthCallbackClaimRequest {
                flow_id: flow.id,
                opaque_state_hash: state_hash("s"),
                provider: google_provider(),
                pkce_verifier_hash: pkce_hash("p"),
            },
        )
        .await
        .unwrap();
    service
        .complete_oauth_callback(
            &scope,
            OAuthCallbackInput {
                flow_id: flow.id,
                opaque_state_hash: state_hash("s"),
                outcome: ironclaw_auth::ProviderCallbackOutcome::Authorized {
                    exchange: OAuthProviderExchange {
                        provider: google_provider(),
                        account_label: account_label(),
                        authorization_code_hash: code_hash("c"),
                        pkce_verifier_hash: pkce_hash("p"),
                        access_secret: SecretHandle::new("access").unwrap(),
                        refresh_secret: None,
                        scopes: vec![],
                        account_id: None,
                    },
                },
            },
        )
        .await
        .unwrap();

    let first_at = Utc::now();
    let first = service
        .mark_continuation_dispatched(&scope, flow.id, first_at)
        .await
        .unwrap();
    assert_eq!(first.continuation_emitted_at, Some(first_at));

    // Second call with a different timestamp must NOT overwrite.
    let second_at = first_at + Duration::seconds(1);
    let second = service
        .mark_continuation_dispatched(&scope, flow.id, second_at)
        .await
        .unwrap();
    assert_eq!(
        second.continuation_emitted_at,
        Some(first_at),
        "idempotent: second call must not overwrite the first emitted_at"
    );
}

// ─── zmanian follow-up #1: OAuth re-auth must purge previous secret handles ──

#[tokio::test]
async fn filesystem_oauth_reauth_purges_previous_provider_secrets() {
    // After a successful OAuth re-auth (exchange.account_id == Some(_)),
    // the OLD access and refresh secret handles must be deleted from SecretStore
    // so repeated re-auths do not accumulate dead handles.
    use ironclaw_auth::{CredentialAccountUpdateBinding, ProviderCallbackOutcome};
    use ironclaw_secrets::SecretMaterial;

    let filesystem = test_filesystem();
    let concrete_secret_store = Arc::new(InMemorySecretStore::new());
    let secret_store: Arc<dyn SecretStore> = concrete_secret_store.clone();
    let scope = test_scope();
    let service = test_service(Arc::clone(&filesystem), Arc::clone(&secret_store));

    // ── Step 1: initial OAuth flow creates a new account ─────────────────────
    let flow1 = service
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
            opaque_state_hash: Some(state_hash("state1")),
            pkce_verifier_hash: Some(pkce_hash("pkce1")),
            expires_at: Utc::now() + Duration::minutes(5),
        })
        .await
        .unwrap();

    service
        .claim_oauth_callback(
            &scope,
            OAuthCallbackClaimRequest {
                flow_id: flow1.id,
                opaque_state_hash: state_hash("state1"),
                provider: google_provider(),
                pkce_verifier_hash: pkce_hash("pkce1"),
            },
        )
        .await
        .unwrap();

    let access_v1 = SecretHandle::new("oauth-access-v1").unwrap();
    let refresh_v1 = SecretHandle::new("oauth-refresh-v1").unwrap();
    // Pre-populate SecretStore to simulate provider client having stored these
    // handles; this lets us verify they are purged on re-auth.
    concrete_secret_store
        .put(
            scope.resource.clone(),
            access_v1.clone(),
            SecretMaterial::from("access-token-v1"),
        )
        .await
        .unwrap();
    concrete_secret_store
        .put(
            scope.resource.clone(),
            refresh_v1.clone(),
            SecretMaterial::from("refresh-token-v1"),
        )
        .await
        .unwrap();

    let completed1 = service
        .complete_oauth_callback(
            &scope,
            OAuthCallbackInput {
                flow_id: flow1.id,
                opaque_state_hash: state_hash("state1"),
                outcome: ProviderCallbackOutcome::Authorized {
                    exchange: OAuthProviderExchange {
                        provider: google_provider(),
                        account_label: account_label(),
                        authorization_code_hash: code_hash("code1"),
                        pkce_verifier_hash: pkce_hash("pkce1"),
                        access_secret: access_v1.clone(),
                        refresh_secret: Some(refresh_v1.clone()),
                        scopes: vec![ProviderScope::new("gmail.readonly").unwrap()],
                        account_id: None,
                    },
                },
            },
        )
        .await
        .unwrap();
    let account_id = completed1
        .credential_account_id
        .expect("first OAuth flow must produce a credential account");

    // v1 handles must be present before re-auth.
    assert!(
        concrete_secret_store
            .metadata(&scope.resource, &access_v1)
            .await
            .unwrap()
            .is_some(),
        "v1 access handle must exist before re-auth"
    );
    assert!(
        concrete_secret_store
            .metadata(&scope.resource, &refresh_v1)
            .await
            .unwrap()
            .is_some(),
        "v1 refresh handle must exist before re-auth"
    );

    // ── Step 2: re-auth flow bound to the existing account ───────────────────
    let flow2 = service
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
            update_binding: Some(CredentialAccountUpdateBinding {
                account_id,
                ownership: CredentialOwnership::UserReusable,
                owner_extension: None,
                granted_extensions: vec![],
            }),
            opaque_state_hash: Some(state_hash("state2")),
            pkce_verifier_hash: Some(pkce_hash("pkce2")),
            expires_at: Utc::now() + Duration::minutes(5),
        })
        .await
        .unwrap();

    service
        .claim_oauth_callback(
            &scope,
            OAuthCallbackClaimRequest {
                flow_id: flow2.id,
                opaque_state_hash: state_hash("state2"),
                provider: google_provider(),
                pkce_verifier_hash: pkce_hash("pkce2"),
            },
        )
        .await
        .unwrap();

    let access_v2 = SecretHandle::new("oauth-access-v2").unwrap();
    let refresh_v2 = SecretHandle::new("oauth-refresh-v2").unwrap();
    concrete_secret_store
        .put(
            scope.resource.clone(),
            access_v2.clone(),
            SecretMaterial::from("access-token-v2"),
        )
        .await
        .unwrap();
    concrete_secret_store
        .put(
            scope.resource.clone(),
            refresh_v2.clone(),
            SecretMaterial::from("refresh-token-v2"),
        )
        .await
        .unwrap();

    service
        .complete_oauth_callback(
            &scope,
            OAuthCallbackInput {
                flow_id: flow2.id,
                opaque_state_hash: state_hash("state2"),
                outcome: ProviderCallbackOutcome::Authorized {
                    exchange: OAuthProviderExchange {
                        provider: google_provider(),
                        account_label: account_label(),
                        authorization_code_hash: code_hash("code2"),
                        pkce_verifier_hash: pkce_hash("pkce2"),
                        access_secret: access_v2.clone(),
                        refresh_secret: Some(refresh_v2.clone()),
                        scopes: vec![ProviderScope::new("gmail.readonly").unwrap()],
                        account_id: Some(account_id),
                    },
                },
            },
        )
        .await
        .unwrap();

    // Old handles must have been purged from SecretStore.
    assert!(
        concrete_secret_store
            .metadata(&scope.resource, &access_v1)
            .await
            .unwrap()
            .is_none(),
        "v1 access handle must be purged from SecretStore after re-auth"
    );
    assert!(
        concrete_secret_store
            .metadata(&scope.resource, &refresh_v1)
            .await
            .unwrap()
            .is_none(),
        "v1 refresh handle must be purged from SecretStore after re-auth"
    );

    // New handles must remain.
    assert!(
        concrete_secret_store
            .metadata(&scope.resource, &access_v2)
            .await
            .unwrap()
            .is_some(),
        "v2 access handle must be present in SecretStore after re-auth"
    );
    assert!(
        concrete_secret_store
            .metadata(&scope.resource, &refresh_v2)
            .await
            .unwrap()
            .is_some(),
        "v2 refresh handle must be present in SecretStore after re-auth"
    );
}

// ─── [High · tests] manual-token submit cleans up secret on account write fail

#[tokio::test]
async fn filesystem_manual_token_submit_cleans_up_secret_when_account_write_fails() {
    // create_or_update_manual_token_account (None path) stores the secret first,
    // then calls create_account_with_id(CasExpectation::Absent). If the write
    // fails the newly-stored secret must be deleted from SecretStore so it does
    // not orphan in the store.
    //
    // Failure injection: derive the account ID that submit_manual_token will use
    // (CredentialAccountId::from_uuid(interaction_id.as_uuid())) and write a
    // dummy record at that path before submitting, causing CasExpectation::Absent
    // to return VersionMismatch → BackendConflict.
    use ironclaw_auth::CredentialAccountId;
    use ironclaw_filesystem::CasExpectation;

    let filesystem = test_filesystem();
    let concrete_secret_store = Arc::new(InMemorySecretStore::new());
    let secret_store: Arc<dyn SecretStore> = concrete_secret_store.clone();
    let scope = test_scope();
    let service = test_service(Arc::clone(&filesystem), Arc::clone(&secret_store));

    // Request an interaction so we know its ID (and can derive the account path).
    let challenge = service
        .request_secret_input(ManualTokenSetupRequest {
            scope: scope.clone(),
            provider: google_provider(),
            label: account_label(),
            continuation: AuthContinuationRef::SetupOnly,
            update_binding: None,
            expires_at: Utc::now() + Duration::minutes(5),
        })
        .await
        .unwrap();
    let AuthChallenge::ManualTokenRequired { interaction_id, .. } = challenge else {
        panic!("expected ManualTokenRequired");
    };

    // Derive the same account ID the submit path will use.
    let account_id = CredentialAccountId::from_uuid(interaction_id.as_uuid());

    // Write a dummy record at that path so create_account_with_id(Absent) fails.
    let dummy_account = ironclaw_auth::CredentialAccount {
        id: account_id,
        scope: scope.clone(),
        provider: google_provider(),
        label: account_label(),
        status: ironclaw_auth::CredentialAccountStatus::Configured,
        ownership: CredentialOwnership::UserReusable,
        owner_extension: None,
        granted_extensions: vec![],
        access_secret: None,
        refresh_secret: None,
        scopes: vec![],
        created_at: Utc::now(),
        updated_at: Utc::now(),
    };
    let path = super::paths::account_path(&scope, account_id)
        .expect("account path derivation must succeed");
    let json = serde_json::to_vec(&dummy_account).expect("serialization must succeed");
    use ironclaw_filesystem::{ContentType, Entry};
    let entry = Entry::bytes(json).with_content_type(ContentType::json());
    filesystem
        .put(&scope.resource, &path, entry, CasExpectation::Absent)
        .await
        .expect("pre-create dummy account must succeed");

    // Submit the token — account write will fail; cleanup must run.
    let result = service
        .submit_manual_token(
            &scope,
            SecretSubmitRequest {
                interaction_id,
                secret: SecretString::from("token-value"),
            },
        )
        .await;
    assert!(result.is_err(), "submit must fail when account write fails");

    // The secret stored before the failing write must have been purged.
    let access_handle = super::paths::manual_token_secret_handle(account_id, interaction_id)
        .expect("handle derivation must succeed");
    assert!(
        concrete_secret_store
            .metadata(&scope.resource, &access_handle)
            .await
            .unwrap()
            .is_none(),
        "orphaned secret must be purged from SecretStore after failed account write"
    );
}

// ─── fix: OAuth callback CAS-conflict re-read branch ─────────────────────────

#[tokio::test]
async fn filesystem_oauth_callback_cas_conflict_reuses_concurrent_account() {
    // Pre-create an account with the deterministic id that complete_oauth_callback
    // derives from flow_id (CredentialAccountId::from_uuid(flow_id.as_uuid())).
    // This simulates a concurrent callback that already created the account.
    // The CAS-conflict branch should re-read, validate, update, and succeed.
    let filesystem = test_filesystem();
    let secret_store: Arc<dyn SecretStore> = Arc::new(InMemorySecretStore::new());
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
            opaque_state_hash: Some(state_hash("s2")),
            pkce_verifier_hash: Some(pkce_hash("p2")),
            expires_at: Utc::now() + Duration::minutes(5),
        })
        .await
        .unwrap();

    // Pre-seed the account with the deterministic id.
    let preseeded_id = CredentialAccountId::from_uuid(flow.id.as_uuid());
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
                access_secret: Some(SecretHandle::new("pre-seeded-access").unwrap()),
                refresh_secret: None,
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
                opaque_state_hash: state_hash("s2"),
                provider: google_provider(),
                pkce_verifier_hash: pkce_hash("p2"),
            },
        )
        .await
        .unwrap();

    let completed = service
        .complete_oauth_callback(
            &scope,
            OAuthCallbackInput {
                flow_id: flow.id,
                opaque_state_hash: state_hash("s2"),
                outcome: ironclaw_auth::ProviderCallbackOutcome::Authorized {
                    exchange: OAuthProviderExchange {
                        provider: google_provider(),
                        account_label: account_label(),
                        authorization_code_hash: code_hash("c2"),
                        pkce_verifier_hash: pkce_hash("p2"),
                        access_secret: SecretHandle::new("new-access").unwrap(),
                        refresh_secret: Some(SecretHandle::new("new-refresh").unwrap()),
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
        "CAS-conflict branch must reuse the pre-seeded account id"
    );
    assert_eq!(completed.status, AuthFlowStatus::Completed);
}
