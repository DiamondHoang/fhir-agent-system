import requests

import os

# ─── LLM Provider Switch ──────────────────────────────────────────────────
# "ollama"  → dùng Ollama chạy local/nội bộ (mặc định)
# "company" → dùng API nội bộ công ty (khi endpoint company sống lại)
# Đổi bằng cách set LLM_PROVIDER=company trong .env rồi `docker compose up -d`
# (không cần --build, chỉ là biến môi trường).
LLM_PROVIDER = os.getenv("LLM_PROVIDER", "ollama").strip().lower()
_USE_OLLAMA = LLM_PROVIDER == "ollama"


def _provider_env(company_key: str, ollama_key: str, default: str = "") -> str:
    """Đọc biến môi trường tương ứng theo LLM_PROVIDER hiện tại."""
    return os.getenv(ollama_key if _USE_OLLAMA else company_key, default)


# ─── Vision Model — Multimodal (Phân tích hình ảnh) ──────────────────────────
VISION_MODEL_URL = _provider_env("COMPANY_VISION_URL", "OLLAMA_VISION_URL", "http://172.16.12.230:8000")
VISION_MODEL_DEFAULT = _provider_env("COMPANY_VISION_MODEL", "OLLAMA_VISION_MODEL", "gemma-4-26B-A4B-it")
# Từ khóa ưu tiên để nhận dạng đúng model LLM vision (substring match)
VISION_MODEL_PREFER = _provider_env("COMPANY_VISION_PREFER", "OLLAMA_VISION_PREFER", "gemma4")
VISION_MODEL_TIMEOUT = int(os.getenv("VISION_MODEL_TIMEOUT", "600"))

# ─── Reasoning Model — Text (Lập kế hoạch & Chẩn đoán lâm sàng) ─────────────
REASONING_MODEL_URL = _provider_env("COMPANY_REASONING_URL", "OLLAMA_REASONING_URL", "http://172.16.12.230:8000")
REASONING_MODEL_DEFAULT = _provider_env("COMPANY_REASONING_MODEL", "OLLAMA_REASONING_MODEL", "gemma-4-26B-A4B-it")
# Từ khóa ưu tiên để nhận dạng đúng model LLM reasoning (substring match)
REASONING_MODEL_PREFER = _provider_env("COMPANY_REASONING_PREFER", "OLLAMA_REASONING_PREFER", "gemma4")
REASONING_MODEL_TIMEOUT = int(os.getenv("REASONING_MODEL_TIMEOUT", "1200"))

# Danh sách model KHÔNG phải LLM (embedding, reranker...) — bị loại khỏi selection
_NON_LLM_KEYWORDS = ["bge", "embed", "rerank", "e5", "nomic", "minilm", "all-mpnet"]


def _is_embedding_model(model_id: str) -> bool:
    """Return True nếu model_id trông giống embedding/reranker (không phải LLM)."""
    name = model_id.lower()
    return any(kw in name for kw in _NON_LLM_KEYWORDS)


def get_active_model_name(base_url: str, default_model: str, prefer: str = "") -> str:
    """Fetch active model name dynamically from /v1/models endpoint.

    Logic ưu tiên:
      1. Lọc bỏ các model embedding/reranker.
      2. Trong danh sách LLM còn lại, ưu tiên model khớp từ khóa `prefer`.
      3. Nếu không có khớp, lấy model LLM đầu tiên trong danh sách.
      4. Nếu server không phản hồi hoặc danh sách trống → dùng `default_model`.
    """
    try:
        url = f"{base_url.rstrip('/')}/v1/models"
        res = requests.get(url, timeout=3)
        if res.ok:
            data = res.json()
            all_models = data.get("data", [])
            # Lọc bỏ embedding / non-LLM models
            llm_models = [
                m.get("id", "") for m in all_models
                if isinstance(m, dict) and m.get("id") and not _is_embedding_model(m["id"])
            ]
            if llm_models:
                if prefer:
                    # Ưu tiên model có chứa từ khóa prefer (không phân biệt hoa/thường)
                    matched = [m for m in llm_models if prefer.lower() in m.lower()]
                    if matched:
                        return matched[0]
                # Không có prefer match → lấy LLM đầu tiên
                return llm_models[0]
    except Exception:
        pass
    return default_model


# ─── Resolved model names (tự động, có fallback) ─────────────────────────────
VISION_MODEL_NAME = get_active_model_name(VISION_MODEL_URL, VISION_MODEL_DEFAULT, VISION_MODEL_PREFER)
REASONING_MODEL_NAME = get_active_model_name(REASONING_MODEL_URL, REASONING_MODEL_DEFAULT, REASONING_MODEL_PREFER)

DEFAULT_TIMEOUT = 120
DEFAULT_MAX_RETRIES = 2
DEFAULT_MAX_TOKENS = 8192

import os

# Embedding model — dùng cho knowledge base search (utils/knowledge_base.py).
EMBEDDING_URL = _provider_env("COMPANY_KB_EMBEDDING_URL", "OLLAMA_KB_EMBEDDING_URL", "http://172.16.12.230:8004")
EMBEDDING_MODEL = _provider_env("COMPANY_KB_EMBEDDING_MODEL", "OLLAMA_KB_EMBEDDING_MODEL", "BAAI/bge-m3")
EMBEDDING_TIMEOUT = int(os.getenv("EMBEDDING_TIMEOUT", "120"))

# Qdrant vector store cho knowledge base.
# Chế độ "local": chạy embedded, lưu file lên đĩa tại QDRANT_PATH — không cần
#   server riêng, phù hợp lúc KB còn nhỏ/vừa.
# Chế độ "server": kết nối tới Qdrant server thật qua QDRANT_URL (vd chạy
#   `docker run -p 6333:6333 qdrant/qdrant`) — đổi sang chế độ này khi KB lớn
#   lên hoặc cần chạy nhiều worker process cùng lúc (chế độ local chỉ cho 1
#   process truy cập cùng lúc).
QDRANT_MODE = os.getenv("QDRANT_MODE", "server")  # "local" | "server"
QDRANT_PATH = os.getenv("QDRANT_PATH", "knowledge_base/.qdrant_index")
QDRANT_URL = os.getenv("QDRANT_URL", "http://localhost:6333")
QDRANT_COLLECTION = os.getenv("QDRANT_COLLECTION", "disease_symptoms")
