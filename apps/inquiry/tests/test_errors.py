from src.errors import (
    ConfigError,
    EnrichmentError,
    ExtractionError,
    InquiryAutomationError,
    MissingSecretError,
    RuntimeLogError,
    SupabaseAuthError,
    SupabaseError,
    SupabaseNotFoundError,
)


def test_exception_hierarchy() -> None:
    assert issubclass(ConfigError, InquiryAutomationError)
    assert issubclass(MissingSecretError, ConfigError)
    assert issubclass(RuntimeLogError, InquiryAutomationError)
    assert issubclass(EnrichmentError, InquiryAutomationError)
    assert issubclass(ExtractionError, EnrichmentError)
    assert issubclass(SupabaseError, InquiryAutomationError)
    assert issubclass(SupabaseAuthError, SupabaseError)
    assert issubclass(SupabaseNotFoundError, SupabaseError)


def test_exception_messages() -> None:
    assert str(ConfigError("msg")) == "msg"
    assert str(MissingSecretError("missing SUPABASE_URL")) == "missing SUPABASE_URL"
    assert str(SupabaseAuthError("auth failed")) == "auth failed"
