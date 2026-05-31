use super::*;

// ─── tests: broker projection contract (#4238) ───────────────────────────────
//
// These tests assert that every product-auth `write_account` call site
// invokes the broker projector exactly once with the persisted record,
// and that projector failures are non-fatal to the product-auth flow.

mod broker_projection_tests {
    use super::*;
    use async_trait::async_trait;
    use ironclaw_auth::{SecretCleanupAction, SecretCleanupRequest, SecretCleanupService};
    use ironclaw_host_api::ExtensionId;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Projector that fails on every call.  Used to assert product-auth
    /// flows are resilient to broker projection failure.
    struct FailingBrokerProjector {
        calls: AtomicUsize,
    }

    impl FailingBrokerProjector {
        fn new() -> Self {
            Self {
                calls: AtomicUsize::new(0),
            }
        }

        fn calls(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }
    }

    #[async_trait]
    impl super::super::super::broker_projection::BrokerAccountProjector for FailingBrokerProjector {
        async fn project_account(&self, _account: &ironclaw_auth::CredentialAccount) {
            self.calls.fetch_add(1, Ordering::SeqCst);
            // Real implementations would propagate a tracing::warn here.
            // The trait contract is that this method MUST NOT panic and
            // MUST NOT return an error.  We do nothing visible.
        }
    }

    #[tokio::test]
    async fn default_projector_writes_mapped_account_to_broker_store() {
        let filesystem = test_filesystem();
        let secret_store: Arc<dyn SecretStore> = Arc::new(InMemorySecretStore::new());
        let broker = Arc::new(InMemoryCredentialBroker::new());
        let credential_store: Arc<dyn CredentialAccountStore> = broker.clone();
        let service = FilesystemAuthProductServices::new(
            filesystem,
            secret_store,
            super::super::super::default_broker_projector(credential_store),
        );
        let scope = test_scope();

        let created = service
            .create_account(NewCredentialAccount {
                scope: scope.clone(),
                provider: google_provider(),
                label: account_label(),
                status: CredentialAccountStatus::Configured,
                ownership: CredentialOwnership::UserReusable,
                owner_extension: None,
                granted_extensions: vec![],
                access_secret: Some(SecretHandle::new("broker-access").unwrap()),
                refresh_secret: Some(SecretHandle::new("broker-refresh").unwrap()),
                scopes: vec![],
            })
            .await
            .unwrap();

        let broker_id = ironclaw_secrets::CredentialAccountId::new(created.id.to_string()).unwrap();
        let projected = broker
            .get_account(&scope.resource, &broker_id)
            .await
            .unwrap()
            .expect("projector must write broker account");
        assert_eq!(projected.id, broker_id);
        assert_eq!(
            projected.status,
            ironclaw_secrets::CredentialAccountStatus::Active,
        );
        assert_eq!(projected.secret_handles.len(), 2);
    }

    #[tokio::test]
    async fn unusable_status_update_projects_fail_closed_broker_row() {
        let filesystem = test_filesystem();
        let secret_store: Arc<dyn SecretStore> = Arc::new(InMemorySecretStore::new());
        let broker = Arc::new(InMemoryCredentialBroker::new());
        let credential_store: Arc<dyn CredentialAccountStore> = broker.clone();
        let service = FilesystemAuthProductServices::new(
            filesystem,
            secret_store,
            super::super::super::default_broker_projector(credential_store),
        );
        let scope = test_scope();

        let created = service
            .create_account(NewCredentialAccount {
                scope: scope.clone(),
                provider: google_provider(),
                label: account_label(),
                status: CredentialAccountStatus::Configured,
                ownership: CredentialOwnership::UserReusable,
                owner_extension: None,
                granted_extensions: vec![],
                access_secret: Some(SecretHandle::new("inactive-access").unwrap()),
                refresh_secret: None,
                scopes: vec![],
            })
            .await
            .unwrap();

        service
            .update_status(&scope, created.id, CredentialAccountStatus::Inactive)
            .await
            .unwrap();

        let broker_id = ironclaw_secrets::CredentialAccountId::new(created.id.to_string()).unwrap();
        let projected = broker
            .get_account(&scope.resource, &broker_id)
            .await
            .unwrap()
            .expect("inactive product-auth state must still tombstone broker row");
        assert_eq!(
            projected.status,
            ironclaw_secrets::CredentialAccountStatus::Revoked,
        );
        assert!(
            projected.secret_handles.is_empty(),
            "fail-closed broker row must not retain stale handles",
        );
    }

    #[tokio::test]
    async fn stale_projection_cannot_overwrite_newer_broker_state() {
        let filesystem = test_filesystem();
        let secret_store: Arc<dyn SecretStore> = Arc::new(InMemorySecretStore::new());
        let broker = Arc::new(InMemoryCredentialBroker::new());
        let credential_store: Arc<dyn CredentialAccountStore> = broker.clone();
        let projector = super::super::super::default_broker_projector(credential_store);
        let service =
            FilesystemAuthProductServices::new(filesystem, secret_store, Arc::clone(&projector));
        let scope = test_scope();

        let older = service
            .create_account(NewCredentialAccount {
                scope: scope.clone(),
                provider: google_provider(),
                label: account_label(),
                status: CredentialAccountStatus::Configured,
                ownership: CredentialOwnership::UserReusable,
                owner_extension: None,
                granted_extensions: vec![],
                access_secret: Some(SecretHandle::new("older-access").unwrap()),
                refresh_secret: None,
                scopes: vec![],
            })
            .await
            .unwrap();
        let newer = service
            .update_status(&scope, older.id, CredentialAccountStatus::Revoked)
            .await
            .unwrap();
        assert!(newer.updated_at >= older.updated_at);

        projector.project_account(&older).await;

        let broker_id = ironclaw_secrets::CredentialAccountId::new(older.id.to_string()).unwrap();
        let projected = broker
            .get_account(&scope.resource, &broker_id)
            .await
            .unwrap()
            .expect("broker row must remain present");
        assert_eq!(
            projected.status,
            ironclaw_secrets::CredentialAccountStatus::Revoked,
            "older Active projection must not overwrite newer Revoked state",
        );
    }

    #[tokio::test]
    async fn create_account_projects_configured_state_once() {
        let filesystem = test_filesystem();
        let secret_store: Arc<dyn SecretStore> = Arc::new(InMemorySecretStore::new());
        let scope = test_scope();
        let (service, projector) = test_service_with_recording_projector(filesystem, secret_store);

        let created = service
            .create_account(NewCredentialAccount {
                scope: scope.clone(),
                provider: google_provider(),
                label: account_label(),
                status: CredentialAccountStatus::Configured,
                ownership: CredentialOwnership::UserReusable,
                owner_extension: None,
                granted_extensions: vec![],
                access_secret: Some(SecretHandle::new("oauth-access").unwrap()),
                refresh_secret: None,
                scopes: vec![],
            })
            .await
            .unwrap();

        let records = projector.records();
        assert_eq!(records.len(), 1, "create_account must project exactly once",);
        assert_eq!(records[0].id, created.id);
        assert_eq!(records[0].status, CredentialAccountStatus::Configured);
    }

    #[tokio::test]
    async fn cleanup_uninstall_projects_revoked_state() {
        let filesystem = test_filesystem();
        let concrete_secret_store = Arc::new(InMemorySecretStore::new());
        let secret_store: Arc<dyn SecretStore> = concrete_secret_store.clone();
        let scope = test_scope();
        let (service, projector) = test_service_with_recording_projector(
            Arc::clone(&filesystem),
            Arc::clone(&secret_store),
        );

        let ext_id = ExtensionId::new("ext-projection").unwrap();
        let access = SecretHandle::new("ext-access").unwrap();
        use secrecy::SecretString;
        concrete_secret_store
            .put(
                scope.resource.clone(),
                access.clone(),
                SecretString::from("material"),
            )
            .await
            .unwrap();

        let account = service
            .create_account(NewCredentialAccount {
                scope: scope.clone(),
                provider: google_provider(),
                label: account_label(),
                status: CredentialAccountStatus::Configured,
                ownership: CredentialOwnership::ExtensionOwned,
                owner_extension: Some(ext_id.clone()),
                granted_extensions: vec![],
                access_secret: Some(access.clone()),
                refresh_secret: None,
                scopes: vec![],
            })
            .await
            .unwrap();

        service
            .cleanup_for_lifecycle(SecretCleanupRequest {
                scope: scope.clone(),
                extension_id: ext_id.clone(),
                action: SecretCleanupAction::Uninstall,
            })
            .await
            .unwrap();

        let records = projector.records();
        assert_eq!(
            records.len(),
            2,
            "create + cleanup must each emit one projection",
        );
        assert_eq!(records[0].status, CredentialAccountStatus::Configured);
        assert_eq!(records[1].id, account.id);
        assert_eq!(
            records[1].status,
            CredentialAccountStatus::Revoked,
            "uninstall must project Revoked state to the broker",
        );
    }

    #[tokio::test]
    async fn projection_failure_does_not_block_product_auth_write() {
        let filesystem = test_filesystem();
        let secret_store: Arc<dyn SecretStore> = Arc::new(InMemorySecretStore::new());
        let scope = test_scope();
        let projector = Arc::new(FailingBrokerProjector::new());
        let service = FilesystemAuthProductServices::new(
            filesystem,
            secret_store,
            Arc::clone(&projector)
                as Arc<dyn super::super::super::broker_projection::BrokerAccountProjector>,
        );

        // The product-auth write must succeed even though the projector
        // is configured to fail.  This is the "non-fatal but observable"
        // contract from the broker_projection module docs.
        let created = service
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
            .expect("product-auth write must succeed despite projector failure");

        // Read-back confirms durable record was persisted.
        let fetched = service
            .get_account(CredentialAccountLookupRequest::new(scope, created.id))
            .await
            .unwrap()
            .expect("account must be durable");
        assert_eq!(fetched.id, created.id);
        assert_eq!(
            projector.calls(),
            1,
            "projector must be invoked exactly once per write",
        );
    }

    #[tokio::test]
    async fn update_projects_each_write() {
        use ironclaw_auth::CredentialAccountMutation;

        let filesystem = test_filesystem();
        let secret_store: Arc<dyn SecretStore> = Arc::new(InMemorySecretStore::new());
        let scope = test_scope();
        let (service, projector) = test_service_with_recording_projector(filesystem, secret_store);

        let created = service
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
        assert_eq!(projector.records().len(), 1);

        // Drive an update through CredentialSetupService.  Each write_account
        // call (in flows, accounts, interactions, cleanup) must project.
        use ironclaw_auth::{CredentialAccountUpdate, CredentialSetupService};
        let update = CredentialAccountUpdate {
            account_id: created.id,
            account: NewCredentialAccount {
                scope: scope.clone(),
                provider: google_provider(),
                label: CredentialAccountLabel::new("Alice Google (refreshed)").unwrap(),
                status: CredentialAccountStatus::Configured,
                ownership: CredentialOwnership::UserReusable,
                owner_extension: None,
                granted_extensions: vec![],
                access_secret: Some(SecretHandle::new("rotated-access").unwrap()),
                refresh_secret: None,
                scopes: vec![],
            },
        };
        let updated = service
            .create_or_update_account(CredentialAccountMutation::Update(update))
            .await
            .unwrap();
        assert_eq!(updated.id, created.id);

        let records = projector.records();
        assert_eq!(records.len(), 2, "create + update must each project once");
        assert_eq!(records[1].id, created.id);
        assert_eq!(
            records[1].label.as_str(),
            "Alice Google (refreshed)",
            "projected record reflects updated label",
        );
    }
}
