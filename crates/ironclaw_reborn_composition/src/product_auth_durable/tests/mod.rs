use std::sync::Arc;

use chrono::{Duration, Utc};
use ironclaw_filesystem::{InMemoryBackend, ScopedFilesystem};
use ironclaw_host_api::{
    InvocationId, MountAlias, MountGrant, MountPermissions, SecretHandle, UserId, VirtualPath,
};
use ironclaw_secrets::{
    CredentialAccountStore, InMemoryCredentialBroker, InMemorySecretStore, SecretStore,
};
use secrecy::SecretString;
use tokio::task::JoinSet;

use super::*;
use ironclaw_auth::{
    AuthChallenge, AuthContinuationRef, AuthFlowKind, AuthFlowManager, AuthFlowStatus,
    AuthInteractionService, AuthProductError, AuthProductScope, AuthProviderId, AuthSurface,
    AuthorizationCodeHash, CredentialAccountChoiceRequest, CredentialAccountLabel,
    CredentialAccountListRequest, CredentialAccountLookupRequest,
    CredentialAccountSelectionRequest, CredentialAccountService, CredentialAccountStatus,
    CredentialOwnership, ManualTokenSetupRequest, NewAuthFlow, NewCredentialAccount,
    OAuthAuthorizationUrl, OAuthCallbackClaimRequest, OAuthCallbackInput, OAuthProviderExchange,
    OpaqueStateHash, PkceVerifierHash, ProviderScope, SecretSubmitRequest,
};

fn test_scope() -> AuthProductScope {
    let resource =
        ResourceScope::local_default(UserId::new("alice").unwrap(), InvocationId::new()).unwrap();
    AuthProductScope::new(resource, AuthSurface::Web)
}

fn test_filesystem() -> Arc<ScopedFilesystem<InMemoryBackend>> {
    let mounts = ironclaw_host_api::MountView::new(vec![MountGrant::new(
        MountAlias::new("/secrets").unwrap(),
        VirtualPath::new("/tenants/test/users/alice/secrets").unwrap(),
        MountPermissions::read_write_list_delete(),
    )])
    .unwrap();
    Arc::new(ScopedFilesystem::with_fixed_view(
        Arc::new(InMemoryBackend::new()),
        mounts,
    ))
}

fn test_service(
    filesystem: Arc<ScopedFilesystem<InMemoryBackend>>,
    secret_store: Arc<dyn SecretStore>,
) -> FilesystemAuthProductServices<InMemoryBackend> {
    FilesystemAuthProductServices::new(
        filesystem,
        secret_store,
        Arc::new(super::NoopBrokerAccountProjector),
    )
}

/// Variant of [`test_service`] that installs a recording projector and
/// returns it so the caller can assert projection invocations after
/// driving a flow.  Used by `broker_projection_tests` below.
fn test_service_with_recording_projector(
    filesystem: Arc<ScopedFilesystem<InMemoryBackend>>,
    secret_store: Arc<dyn SecretStore>,
) -> (
    FilesystemAuthProductServices<InMemoryBackend>,
    Arc<super::broker_projection::test_support::RecordingBrokerProjector>,
) {
    let projector =
        Arc::new(super::broker_projection::test_support::RecordingBrokerProjector::new());
    let service = FilesystemAuthProductServices::new(
        filesystem,
        secret_store,
        Arc::clone(&projector) as Arc<dyn super::broker_projection::BrokerAccountProjector>,
    );
    (service, projector)
}

fn google_provider() -> AuthProviderId {
    AuthProviderId::new("google").unwrap()
}

fn account_label() -> CredentialAccountLabel {
    CredentialAccountLabel::new("Alice Google").unwrap()
}

fn fake_digest(value: &str) -> String {
    format!(
        "{:064x}",
        value.bytes().fold(0_u64, |hash, byte| {
            hash.wrapping_mul(31).wrapping_add(u64::from(byte))
        })
    )
}

fn state_hash(value: &str) -> OpaqueStateHash {
    OpaqueStateHash::new(fake_digest(value)).unwrap()
}

fn pkce_hash(value: &str) -> PkceVerifierHash {
    PkceVerifierHash::new(fake_digest(value)).unwrap()
}

fn code_hash(value: &str) -> AuthorizationCodeHash {
    AuthorizationCodeHash::new(fake_digest(value)).unwrap()
}

mod accounts;
mod broker_projection;
mod cleanup;
mod flow_lifecycle;
mod manual_tokens;
mod oauth_callbacks;
mod oauth_secret_cleanup;
mod provider;
