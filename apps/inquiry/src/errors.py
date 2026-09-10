class InquiryAutomationError(Exception):
    """Base exception for inquiry automation."""


class ConfigError(InquiryAutomationError):
    """Configuration loading or validation failed."""


class MissingSecretError(ConfigError):
    """A required environment variable is not set."""


class RuntimeLogError(InquiryAutomationError):
    """Runtime log read or write failed."""


class EnrichmentError(InquiryAutomationError):
    """Base exception for Mercari inquiry enrichment errors."""


class ExtractionError(EnrichmentError):
    """Browser-based extraction failed."""


class CodexError(ExtractionError):
    """Deprecated alias retained for enrichment API compatibility."""


class SupabaseError(InquiryAutomationError):
    """Supabase/PostgREST API request failed."""


class SupabaseAuthError(SupabaseError):
    """Supabase authentication or authorization failed."""


class SupabaseNotFoundError(SupabaseError):
    """Requested Supabase resource was not found."""
