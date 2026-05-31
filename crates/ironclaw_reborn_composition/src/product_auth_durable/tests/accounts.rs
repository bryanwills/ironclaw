use super::*;

#[tokio::test]
async fn filesystem_accounts_survive_service_recreation() {
    let filesystem = test_filesystem();
    let secret_store: Arc<dyn SecretStore> = Arc::new(InMemorySecretStore::new());
    let scope = test_scope();
    let service = test_service(Arc::clone(&filesystem), Arc::clone(&secret_store));

    let created = service
        .create_account(NewCredentialAccount {
            scope: scope.clone(),
            provider: google_provider(),
            label: account_label(),
            status: CredentialAccountStatus::Configured,
            ownership: CredentialOwnership::UserReusable,
            owner_extension: None,
            granted_extensions: Vec::new(),
            access_secret: Some(SecretHandle::new("google-access").unwrap()),
            refresh_secret: Some(SecretHandle::new("google-refresh").unwrap()),
            scopes: vec![ProviderScope::new("gmail.readonly").unwrap()],
        })
        .await
        .unwrap();

    let recreated = test_service(Arc::clone(&filesystem), secret_store);
    let loaded = recreated
        .get_account(CredentialAccountLookupRequest::new(
            scope.clone(),
            created.id,
        ))
        .await
        .unwrap()
        .expect("account should be durable");
    assert_eq!(loaded.id, created.id);
    assert_eq!(loaded.access_secret, created.access_secret);

    let page = recreated
        .list_accounts(CredentialAccountListRequest::new(scope, google_provider()))
        .await
        .unwrap();
    assert_eq!(page.accounts.len(), 1);
    assert_eq!(page.accounts[0].id, created.id);
}

// ─── validate_account_list_request boundary cases ────────────────────────────

#[tokio::test]
async fn filesystem_list_accounts_rejects_zero_and_oversized_limit() {
    let filesystem = test_filesystem();
    let secret_store: Arc<dyn SecretStore> = Arc::new(InMemorySecretStore::new());
    let scope = test_scope();
    let service = test_service(filesystem, secret_store);

    // limit = 0.
    let err = service
        .list_accounts(
            CredentialAccountListRequest::new(scope.clone(), google_provider()).with_limit(0),
        )
        .await
        .expect_err("limit=0 must be rejected");
    assert!(matches!(err, AuthProductError::InvalidRequest { .. }));

    // limit = MAX + 1.
    let err = service
        .list_accounts(
            CredentialAccountListRequest::new(scope.clone(), google_provider())
                .with_limit(CredentialAccountListRequest::MAX_LIMIT + 1),
        )
        .await
        .expect_err("limit > MAX must be rejected");
    assert!(matches!(err, AuthProductError::InvalidRequest { .. }));

    // Cursor + pagination: 2 accounts, limit=1 → next_cursor present.
    for i in 0..2u8 {
        service
            .create_account(ironclaw_auth::NewCredentialAccount {
                scope: scope.clone(),
                provider: google_provider(),
                label: CredentialAccountLabel::new(format!("User {i}")).unwrap(),
                status: CredentialAccountStatus::Configured,
                ownership: CredentialOwnership::UserReusable,
                owner_extension: None,
                granted_extensions: vec![],
                access_secret: None,
                refresh_secret: None,
                scopes: vec![],
            })
            .await
            .unwrap();
    }
    let page = service
        .list_accounts(
            CredentialAccountListRequest::new(scope.clone(), google_provider()).with_limit(1),
        )
        .await
        .unwrap();
    assert_eq!(page.accounts.len(), 1);
    assert!(
        page.next_cursor.is_some(),
        "second page must have next_cursor"
    );
}

// ─── fix: select_unique_configured_account and select_configured_account ──────

#[tokio::test]
async fn filesystem_select_unique_configured_account_single_and_multi() {
    let filesystem = test_filesystem();
    let secret_store: Arc<dyn SecretStore> = Arc::new(InMemorySecretStore::new());
    let scope = test_scope();
    let service = test_service(filesystem, secret_store);

    // No accounts — CredentialMissing.
    let err = service
        .select_unique_configured_account(CredentialAccountSelectionRequest::new(
            scope.clone(),
            google_provider(),
        ))
        .await
        .expect_err("no accounts must return CredentialMissing");
    assert_eq!(err, AuthProductError::CredentialMissing);

    let a1 = service
        .create_account(NewCredentialAccount {
            scope: scope.clone(),
            provider: google_provider(),
            label: account_label(),
            status: CredentialAccountStatus::Configured,
            ownership: CredentialOwnership::UserReusable,
            owner_extension: None,
            granted_extensions: vec![],
            access_secret: None,
            refresh_secret: None,
            scopes: vec![],
        })
        .await
        .unwrap();

    // One configured — returns it.
    let selected = service
        .select_unique_configured_account(CredentialAccountSelectionRequest::new(
            scope.clone(),
            google_provider(),
        ))
        .await
        .unwrap();
    assert_eq!(selected.id, a1.id);

    // Second configured — AccountSelectionRequired.
    service
        .create_account(NewCredentialAccount {
            scope: scope.clone(),
            provider: google_provider(),
            label: CredentialAccountLabel::new("Alice Google 2").unwrap(),
            status: CredentialAccountStatus::Configured,
            ownership: CredentialOwnership::UserReusable,
            owner_extension: None,
            granted_extensions: vec![],
            access_secret: None,
            refresh_secret: None,
            scopes: vec![],
        })
        .await
        .unwrap();

    let err = service
        .select_unique_configured_account(CredentialAccountSelectionRequest::new(
            scope.clone(),
            google_provider(),
        ))
        .await
        .expect_err("two configured must require selection");
    assert_eq!(err, AuthProductError::AccountSelectionRequired);
}

#[tokio::test]
async fn filesystem_select_configured_account_validates_provider_and_rejects_missing() {
    let filesystem = test_filesystem();
    let secret_store: Arc<dyn SecretStore> = Arc::new(InMemorySecretStore::new());
    let scope = test_scope();
    let service = test_service(filesystem, secret_store);

    let account = service
        .create_account(NewCredentialAccount {
            scope: scope.clone(),
            provider: google_provider(),
            label: account_label(),
            status: CredentialAccountStatus::Configured,
            ownership: CredentialOwnership::UserReusable,
            owner_extension: None,
            granted_extensions: vec![],
            access_secret: None,
            refresh_secret: None,
            scopes: vec![],
        })
        .await
        .unwrap();

    // Happy path.
    let selected = service
        .select_configured_account(CredentialAccountChoiceRequest::new(
            scope.clone(),
            google_provider(),
            account.id,
        ))
        .await
        .unwrap();
    assert_eq!(selected.id, account.id);

    // Non-existent account.
    let err = service
        .select_configured_account(CredentialAccountChoiceRequest::new(
            scope.clone(),
            google_provider(),
            CredentialAccountId::new(),
        ))
        .await
        .expect_err("missing account must return CredentialMissing");
    assert_eq!(err, AuthProductError::CredentialMissing);

    // Wrong provider.
    let err = service
        .select_configured_account(CredentialAccountChoiceRequest::new(
            scope.clone(),
            AuthProviderId::new("github").unwrap(),
            account.id,
        ))
        .await
        .expect_err("wrong provider must return CrossScopeDenied");
    assert_eq!(err, AuthProductError::CrossScopeDenied);
}

// ─── tests: update_status, project_credential_recovery, CredentialSetupService update ───

#[tokio::test]
async fn filesystem_update_status_and_cross_scope_rejection() {
    let filesystem = test_filesystem();
    let secret_store: Arc<dyn SecretStore> = Arc::new(InMemorySecretStore::new());
    let scope = test_scope();
    let service = test_service(filesystem, secret_store);

    let account = service
        .create_account(NewCredentialAccount {
            scope: scope.clone(),
            provider: google_provider(),
            label: account_label(),
            status: CredentialAccountStatus::Configured,
            ownership: CredentialOwnership::UserReusable,
            owner_extension: None,
            granted_extensions: vec![],
            access_secret: None,
            refresh_secret: None,
            scopes: vec![],
        })
        .await
        .unwrap();

    let updated = service
        .update_status(&scope, account.id, CredentialAccountStatus::Inactive)
        .await
        .unwrap();
    assert_eq!(updated.status, CredentialAccountStatus::Inactive);

    // Non-existent account.
    let err = service
        .update_status(
            &scope,
            CredentialAccountId::new(),
            CredentialAccountStatus::Inactive,
        )
        .await
        .expect_err("missing account must return CredentialMissing");
    assert_eq!(err, AuthProductError::CredentialMissing);
}

#[tokio::test]
async fn filesystem_project_credential_recovery_returns_setup_required_when_empty() {
    use ironclaw_auth::CredentialRecoveryRequest;
    let filesystem = test_filesystem();
    let secret_store: Arc<dyn SecretStore> = Arc::new(InMemorySecretStore::new());
    let scope = test_scope();
    let service = test_service(filesystem, secret_store);

    // No accounts → setup_required.
    let recovery = service
        .project_credential_recovery(CredentialRecoveryRequest::new(
            scope.clone(),
            google_provider(),
        ))
        .await
        .unwrap();
    use ironclaw_auth::CredentialRecoveryState;
    assert!(
        matches!(
            recovery.state,
            CredentialRecoveryState::SetupRequired { .. }
        ),
        "no accounts must return setup_required"
    );

    // One configured account → configured.
    let account = service
        .create_account(NewCredentialAccount {
            scope: scope.clone(),
            provider: google_provider(),
            label: account_label(),
            status: CredentialAccountStatus::Configured,
            ownership: CredentialOwnership::UserReusable,
            owner_extension: None,
            granted_extensions: vec![],
            access_secret: None,
            refresh_secret: None,
            scopes: vec![],
        })
        .await
        .unwrap();

    let recovery = service
        .project_credential_recovery(CredentialRecoveryRequest::new(
            scope.clone(),
            google_provider(),
        ))
        .await
        .unwrap();
    let CredentialRecoveryState::Configured { selected_account } = &recovery.state else {
        panic!(
            "single configured account must return Configured state, got: {:?}",
            recovery.state
        );
    };
    assert_eq!(selected_account.id, account.id);
}

#[tokio::test]
async fn filesystem_credential_setup_service_update_path() {
    use ironclaw_auth::{
        CredentialAccountMutation, CredentialAccountUpdate, CredentialSetupService,
    };
    let filesystem = test_filesystem();
    let secret_store: Arc<dyn SecretStore> = Arc::new(InMemorySecretStore::new());
    let scope = test_scope();
    let service = test_service(filesystem, secret_store);

    let account = service
        .create_account(NewCredentialAccount {
            scope: scope.clone(),
            provider: google_provider(),
            label: account_label(),
            status: CredentialAccountStatus::Configured,
            ownership: CredentialOwnership::UserReusable,
            owner_extension: None,
            granted_extensions: vec![],
            access_secret: Some(SecretHandle::new("old-access").unwrap()),
            refresh_secret: None,
            scopes: vec![],
        })
        .await
        .unwrap();

    let new_handle = SecretHandle::new("new-access").unwrap();
    let updated = service
        .create_or_update_account(CredentialAccountMutation::Update(CredentialAccountUpdate {
            account_id: account.id,
            account: NewCredentialAccount {
                scope: scope.clone(),
                provider: google_provider(),
                label: account_label(),
                status: CredentialAccountStatus::Configured,
                ownership: CredentialOwnership::UserReusable,
                owner_extension: None,
                granted_extensions: vec![],
                access_secret: Some(new_handle.clone()),
                refresh_secret: None,
                scopes: vec![],
            },
        }))
        .await
        .unwrap();
    assert_eq!(updated.access_secret, Some(new_handle));
}
