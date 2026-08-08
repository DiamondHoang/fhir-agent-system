"""Application configuration from environment variables."""

from pydantic import model_validator
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Application settings loaded from ``.env``."""

    # Neo4j — authoritative FHIR graph
    neo4j_uri: str = ""
    neo4j_username: str = ""
    neo4j_password: str = ""

    # LLM provider switch: "ollama" (mặc định, local) hoặc "company" (nội bộ).
    # Đổi trong .env rồi `docker compose up -d`, không cần rebuild.
    llm_provider: str = "ollama"

    # Company internal OpenAI-compatible API (khi LLM_PROVIDER=company)
    company_llm_base_url: str = ""
    company_llm_api_key: str = ""
    company_llm_model: str = ""
    company_embedding_base_url: str = ""
    company_embedding_api_key: str = ""
    company_embedding_model: str = ""
    company_embedding_dims: int = 1024

    # Local Ollama (khi LLM_PROVIDER=ollama)
    ollama_llm_base_url: str = ""
    ollama_llm_api_key: str = ""
    ollama_llm_model: str = ""
    ollama_embedding_base_url: str = ""
    ollama_embedding_api_key: str = ""
    ollama_embedding_model: str = ""
    ollama_embedding_dims: int = 1024

    @property
    def internal_llm_base_url(self) -> str:
        return self.ollama_llm_base_url if self.llm_provider == "ollama" else self.company_llm_base_url

    @property
    def internal_llm_api_key(self) -> str:
        return self.ollama_llm_api_key if self.llm_provider == "ollama" else self.company_llm_api_key

    @property
    def internal_llm_model(self) -> str:
        return self.ollama_llm_model if self.llm_provider == "ollama" else self.company_llm_model

    @property
    def internal_embedding_base_url(self) -> str:
        return self.ollama_embedding_base_url if self.llm_provider == "ollama" else self.company_embedding_base_url

    @property
    def internal_embedding_api_key(self) -> str:
        return self.ollama_embedding_api_key if self.llm_provider == "ollama" else self.company_embedding_api_key

    @property
    def internal_embedding_model(self) -> str:
        return self.ollama_embedding_model if self.llm_provider == "ollama" else self.company_embedding_model

    @property
    def internal_embedding_dims(self) -> int:
        return self.ollama_embedding_dims if self.llm_provider == "ollama" else self.company_embedding_dims

    # PostgreSQL — Mem0 pgvector store
    postgres_host: str = "localhost"
    postgres_port: int = 5432
    postgres_user: str = "postgres"
    postgres_password: str = "postgres"
    postgres_db: str = "fhir_agent"

    # PostgreSQL — SQLAlchemy async connection
    database_url: str = (
        "postgresql+asyncpg://postgres:postgres@localhost:5432/fhir_agent"
    )

    # Mem0 conversational memory
    mem0_agent_id: str = "fhir-clinical-agent"
    mem0_vector_store_provider: str = "pgvector"
    mem0_collection_name: str = "fhir_agent_memories"

    # Short-term conversational memory
    short_term_enabled: bool = True
    short_term_max_tokens: int = 12000
    short_term_recent_tokens: int = 6000
    short_term_summary_max_tokens: int = 2000
    short_term_compaction_threshold: float = 0.75
    short_term_chars_per_token: float = 4.0

    # JWT authentication
    jwt_secret_key: str = ""
    jwt_algorithm: str = "HS256"
    jwt_access_token_expire_minutes: int = 60

    # Application
    domain_id: str = "healthcare"
    backend_port: int = 8000
    frontend_port: int = 3000

    # Skin diagnostic workflow
    skin_vision_base_url: str = ""
    skin_vision_model: str = ""
    skin_reasoning_base_url: str = ""
    skin_reasoning_model: str = ""
    skin_embedding_base_url: str = ""
    skin_embedding_api_key: str = ""
    skin_embedding_model: str = ""
    skin_llm_max_tokens: int = 4096
    skin_kb_enabled: bool = True
    skin_qdrant_url: str = "http://localhost:6333"
    skin_qdrant_collection: str = "skin_disease_symptoms"
    skin_kb_min_score: float = 0.6
    skin_session_ttl_hours: int = 24
    fhir_server_url: str = ""
    fhir_image_timeout: float = 30.0

    model_config = {
        "env_file": "../.env",
        "env_file_encoding": "utf-8",
        "extra": "ignore",
    }

    @model_validator(mode="after")
    def _validate_required_settings(self):
        required = {
            "NEO4J_URI": self.neo4j_uri,
            "INTERNAL_LLM_BASE_URL": self.internal_llm_base_url,
            "INTERNAL_LLM_MODEL": self.internal_llm_model,
            "INTERNAL_EMBEDDING_BASE_URL": self.internal_embedding_base_url,
            "INTERNAL_EMBEDDING_MODEL": self.internal_embedding_model,
            "POSTGRES_HOST": self.postgres_host,
            "POSTGRES_PORT": str(self.postgres_port),
            "POSTGRES_USER": self.postgres_user,
            "POSTGRES_DB": self.postgres_db,
            "DATABASE_URL": self.database_url,
            "MEM0_VECTOR_STORE_PROVIDER": self.mem0_vector_store_provider,
            "MEM0_COLLECTION_NAME": self.mem0_collection_name,
            "MEM0_AGENT_ID": self.mem0_agent_id,
        }
        missing = [name for name, value in required.items() if not str(value).strip()]
        if missing:
            raise ValueError(f"Missing required settings: {', '.join(missing)}")
        if not self.jwt_secret_key.strip():
            raise ValueError("JWT_SECRET_KEY must not be empty")
        if self.jwt_access_token_expire_minutes <= 0:
            raise ValueError("JWT_ACCESS_TOKEN_EXPIRE_MINUTES must be greater than zero")
        if self.internal_embedding_dims <= 0:
            raise ValueError("INTERNAL_EMBEDDING_DIMS must be greater than zero")
        if self.postgres_port <= 0 or self.postgres_port > 65535:
            raise ValueError("POSTGRES_PORT must be between 1 and 65535")
        if self.short_term_max_tokens <= 0:
            raise ValueError("SHORT_TERM_MAX_TOKENS must be greater than zero")
        if self.short_term_recent_tokens <= 0:
            raise ValueError("SHORT_TERM_RECENT_TOKENS must be greater than zero")
        if self.short_term_summary_max_tokens <= 0:
            raise ValueError("SHORT_TERM_SUMMARY_MAX_TOKENS must be greater than zero")
        if self.short_term_recent_tokens >= self.short_term_max_tokens:
            raise ValueError("SHORT_TERM_RECENT_TOKENS must be less than SHORT_TERM_MAX_TOKENS")
        if not 0 < self.short_term_compaction_threshold <= 1:
            raise ValueError(
                "SHORT_TERM_COMPACTION_THRESHOLD must be greater than zero and less than or equal to one"
            )
        if self.short_term_chars_per_token <= 0:
            raise ValueError("SHORT_TERM_CHARS_PER_TOKEN must be greater than zero")
        if self.skin_llm_max_tokens <= 0:
            raise ValueError("SKIN_LLM_MAX_TOKENS must be greater than zero")
        if self.skin_session_ttl_hours <= 0:
            raise ValueError("SKIN_SESSION_TTL_HOURS must be greater than zero")
        if not 0 <= self.skin_kb_min_score <= 1:
            raise ValueError("SKIN_KB_MIN_SCORE must be between zero and one")
        return self


settings = Settings()