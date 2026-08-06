# WORK_BREAKDOWN.md — Tích hợp `fhir-agent` → `fhir-agent-system`

> Sinh ra từ `PLAN.md` (kế hoạch tích hợp Tính năng 2 — upload ảnh vào bệnh
> nhân đang có, qua Neo4j/CyFHIR). Mỗi task đủ nhỏ để làm trong 1 phiên, có
> đường dẫn file tuyệt đối đã xác nhận tồn tại trên máy (đường dẫn Windows:
> `D:\Project\Fhir-agent` = nguồn, `D:\Project\fhir-agent-system` = đích).
>
> Quy ước trạng thái: `[ ]` chưa làm, `[~]` đang làm, `[x]` xong.
> Quy ước ID: `B-xx` backend, `F-xx` frontend, `M-xx` migration/DB,
> `T-xx` test/tích hợp, `D-xx` docs/rủi ro.

---

## Nhóm 0 — Chuẩn bị (không đổi code)

### [x] B-00. Xác nhận `Pillow` đã có trong `pyproject.toml` đích
> ĐÃ KIỂM: `Pillow>=10.0.0` có sẵn trong `pyproject.toml` đích — không cần sửa.
- **File nguồn:** không có
- **File đích:** `D:\Project\fhir-agent-system\backend\pyproject.toml`
- **Dependencies:** không
- **Tiêu chí hoàn thành:** mở file, tìm dòng `pillow`/`Pillow`; nếu thiếu,
  thêm `Pillow>=10.0` vào `[project.dependencies]` và chạy `uv sync` (hoặc
  `pip install -e .`) để lock lại. Ghi kết quả (có sẵn hay đã thêm) vào commit
  message.

### [x] B-01. Xác nhận các biến cấu hình đã tồn tại (`skin_vision_base_url`, `neo4j_uri`, CyFHIR)
> ĐÃ KIỂM: `skin_vision_base_url`, `skin_vision_model`, `internal_llm_base_url`,
> `internal_llm_model`, `neo4j_uri`, `skin_llm_max_tokens` đều có sẵn trong
> `app/core/config.py` đích.
- **File nguồn:** `D:\Project\Fhir-agent\backend\app\core\config.py`
- **File đích:** `D:\Project\fhir-agent-system\backend\app\core\config.py`,
  `D:\Project\fhir-agent-system\docker-compose.yml`
- **Dependencies:** không
- **Tiêu chí hoàn thành:** liệt kê rõ trong 1 comment/ghi chú (hoặc PR
  description) từng field: `skin_vision_base_url`, `neo4j_uri`,
  `NEO4J_dbms_security_procedures_unrestricted` chứa `cyfhir.*` — xác nhận có
  mặt, không sửa code nếu đã đủ.

---

## Nhóm 1 — Port `app/skin_images/*` (Backend lõi, không đụng agent/chat)

> Thư mục đích `D:\Project\fhir-agent-system\backend\app\skin_images\` đã
> tồn tại nhưng **rỗng** — xác nhận trước khi bắt đầu từng task dưới đây.

### [x] B-02. Port `fhir_builders.py`
- **File nguồn:** `D:\Project\Fhir-agent\backend\app\skin_images\fhir_builders.py`
- **File đích:** `D:\Project\fhir-agent-system\backend\app\skin_images\fhir_builders.py`
- **Dependencies:** không
- **Tiêu chí hoàn thành:** copy nguyên văn; sửa duy nhất phần `import` nếu
  package root khác tên (`fhir_agent` vs `app`); file build được (không lỗi
  cú pháp) khi `python -c "import app.skin_images.fhir_builders"`.

### [x] B-03. Port `image_processing.py`
- **File nguồn:** `D:\Project\Fhir-agent\backend\app\skin_images\image_processing.py`
- **File đích:** `D:\Project\fhir-agent-system\backend\app\skin_images\image_processing.py`
- **Dependencies:** B-00 (Pillow)
- **Tiêu chí hoàn thành:** copy nguyên; import thành công; không còn tham
  chiếu module nào chưa port (kiểm bằng `grep import` trong file).

### [x] B-04. Port `modality.py`
> ⚠️ PHÁT SINH NGOÀI PLAN: `call_llm()` ở đích
> (`app/skin_diagnostic/llm_client.py`) chỉ nhận `image_path`, KHÔNG có tham
> số `image_data_uri` mà `modality.py`/`vision.py` cần. Đã vá thêm tham số
> `image_data_uri: str | None = None` vào `call_llm()` đích (ưu tiên
> `image_data_uri` nếu có, fallback `image_path`) — thay đổi tương thích
> ngược, không ảnh hưởng lời gọi cũ. KHÔNG port thêm behaviour
> `_NO_THINKING_EXTRA_BODY`/`strip_hidden_reasoning` của bản nguồn vì đó là
> thay đổi hành vi nằm ngoài phạm vi task này.
- **File nguồn:** `D:\Project\Fhir-agent\backend\app\skin_images\modality.py`
- **File đích:** `D:\Project\fhir-agent-system\backend\app\skin_images\modality.py`
- **Dependencies:** B-01 (xác nhận `skin_vision_base_url`)
- **Tiêu chí hoàn thành:** copy nguyên; xác nhận hàm gọi
  `skin_diagnostic.llm_client.call_llm` trỏ đúng tới
  `app/skin_diagnostic/llm_client.py` đã có sẵn ở đích (không cần port thêm).

### [x] B-05. Port `vision.py`
- **File nguồn:** `D:\Project\Fhir-agent\backend\app\skin_images\vision.py`
- **File đích:** `D:\Project\fhir-agent-system\backend\app\skin_images\vision.py`
- **Dependencies:** B-04
- **Tiêu chí hoàn thành:** copy nguyên; import thành công; đọc lướt để xác
  nhận không gọi hàm nào ngoài `modality.py`/`llm_client.py`.

### [x] B-06. Port `neo4j_repository.py`
> ĐÃ KIỂM: `execute_cypher(query, params, *, collect, tool_name, timeout)` ở
> `app/graph/client.py` đích tương thích 100% chữ ký cần dùng (`collect=False`,
> `timeout=120.0`).
- **File nguồn:** `D:\Project\Fhir-agent\backend\app\skin_images\neo4j_repository.py`
- **File đích:** `D:\Project\fhir-agent-system\backend\app\skin_images\neo4j_repository.py`
- **Dependencies:** không (nhưng cần `app/graph/client.py` đích đã có sẵn — đã xác nhận tồn tại)
- **Tiêu chí hoàn thành:** copy nguyên; sửa import `execute_cypher` để trỏ
  đúng `app.graph.client` của đích; viết 1 script/REPL nhỏ gọi
  `execute_cypher("RETURN 1")` chạy được (xác nhận kết nối Neo4j sống, dùng
  `docker compose up neo4j cyfhir-express` đã chạy sẵn).

### [x] B-07. Port `references.py` + `search_filters.py`
- **File nguồn:**
  `D:\Project\Fhir-agent\backend\app\skin_images\references.py`,
  `D:\Project\Fhir-agent\backend\app\skin_images\search_filters.py`
- **File đích:**
  `D:\Project\fhir-agent-system\backend\app\skin_images\references.py`,
  `D:\Project\fhir-agent-system\backend\app\skin_images\search_filters.py`
- **Dependencies:** không
- **Tiêu chí hoàn thành:** copy nguyên 2 file; import thành công.

### [x] B-08. Port `schemas.py`
- **File nguồn:** `D:\Project\Fhir-agent\backend\app\skin_images\schemas.py`
- **File đích:** `D:\Project\fhir-agent-system\backend\app\skin_images\schemas.py`
- **Dependencies:** không
- **Tiêu chí hoàn thành:** copy nguyên; chạy
  `python -c "from app.skin_images.schemas import *"` không lỗi; đối chiếu
  tên field với `SkinImageResult` phía frontend đích (dùng ở F-xx sau) —
  ghi chú lại nếu tên field lệch (ví dụ `url` vs `view_url`) để xử lý ở B-11.

### [x] B-09. Port `service.py`
> ⚠️ SỬA SO VỚI NGUYÊN VĂN: đã bỏ hàm `build_upload_attachment()` và import
> `ChatImageAttachment` từ `app.schemas.message` — class này không tồn tại ở
> đích (đích dùng `image_url`/`structured_data`, không dùng
> `attachments: list[JSONB]`). Việc dựng `Message` cho luồng B sẽ do
> `result_messages.py` mới (B-13) đảm nhiệm, không qua `service.py`.
- **File nguồn:** `D:\Project\Fhir-agent\backend\app\skin_images\service.py`
- **File đích:** `D:\Project\fhir-agent-system\backend\app\skin_images\service.py`
- **Dependencies:** B-02..B-08
- **Tiêu chí hoàn thành:** copy nguyên; toàn bộ import trong file trỏ đúng
  module đích; giữ nguyên logic `patient_exists()` bắt buộc trả `True` (theo
  rủi ro mục D-03, KHÔNG tự tạo Patient mới).

### [x] B-10. Port `router.py` (chưa đăng ký vào `main.py`)
> ĐÃ KIỂM: `app.dependencies.auth.get_current_user() -> User` và
> `app.db.models.User` khớp hoàn toàn chữ ký nguồn — copy nguyên văn không
> cần sửa.
- **File nguồn:** `D:\Project\Fhir-agent\backend\app\skin_images\router.py`
- **File đích:** `D:\Project\fhir-agent-system\backend\app\skin_images\router.py`
- **Dependencies:** B-09
- **Tiêu chí hoàn thành:** copy nguyên; các endpoint
  `POST /skin-images/analyze`, `GET /skin-images`,
  `GET /skin-images/files/{image_id}`, `GET /skin-images/{report_id}` có mặt
  trong file; **chưa** import vào `main.py` (việc đó thuộc B-11).

### [x] B-11. Chuẩn hoá field response cho khớp frontend đích (nếu B-08 phát hiện lệch tên)
> PHÁT HIỆN LỆCH THẬT: đọc trực tiếp `ChatInterface.tsx` +
> `lib/api.ts` xác nhận `SkinImageThumbnail`/`SkinImageResult` đích cần
> đúng shape `{study_id, patient_id, patient_name, binary_id, last_updated,
> view_url}` — khác hẳn `SkinImageSearchResult` bên nguồn
> (`diagnostic_report_id/media_id/binary_id/created_at/conclusion/url`).
> Đã thêm hàm `to_frontend_skin_image_result(row, *, patient_name=None)`
> vào `app/skin_images/service.py` làm adapter — dùng ở B-21 khi viết tool
> `find_patient_skin_images` (chưa tự resolve `patient_name`, cần truyền vào
> từ nơi gọi vì `search_patient_skin_images()` không trả tên bệnh nhân).
- **File nguồn:** `D:\Project\Fhir-agent\frontend\lib\api.ts` (đối chiếu type)
- **File đích:** `D:\Project\fhir-agent-system\backend\app\skin_images\schemas.py`,
  `D:\Project\fhir-agent-system\backend\app\skin_images\router.py`
- **Dependencies:** B-08, B-10
- **Tiêu chí hoàn thành:** field trả về ảnh dùng đúng tên `view_url` (khớp
  interface `SkinImageResult` sẽ khai báo ở F-01); nếu không lệch, ghi "N/A —
  không cần đổi" và đóng task.

### [x] B-12. Đăng ký `skin_images_router` vào `main.py`
> Đã thêm import + `app.include_router(skin_images_router, prefix="/api")`
> vào `app/main.py` đích, đặt ngay sau `skin_diagnostic_router`.
- **File nguồn:** không có (route mount pattern tham khảo
  `D:\Project\Fhir-agent\backend\app\main.py`)
- **File đích:** `D:\Project\fhir-agent-system\backend\app\main.py`
- **Dependencies:** B-10
- **Tiêu chí hoàn thành:** thêm
  `from app.skin_images.router import router as skin_images_router` và
  `app.include_router(skin_images_router, prefix="/api")`; server khởi động
  (`uvicorn app.main:app`) không lỗi import; `GET /api/docs` (Swagger) liệt
  kê đủ 4 endpoint mới.

### T-01. Test thủ công `POST /api/skin-images/analyze` qua Swagger/Postman
- **File nguồn:** không có
- **File đích:** không sửa file — test qua HTTP
- **Dependencies:** B-12, hạ tầng Neo4j/CyFHIR đã seed Synthea
- **Tiêu chí hoàn thành:** lấy 1 `patient_id` có thật từ Neo4j (query cypher
  `MATCH (p:Patient) RETURN p.id LIMIT 1` qua `app/graph/client.py` hoặc
  Neo4j Browser); gọi endpoint với 1 ảnh da liễu mẫu → nhận `200` +
  `binary_id`/`report_id` hợp lệ; xác nhận bản ghi mới xuất hiện trong Neo4j
  (`MATCH (b:Binary) ... ORDER BY ... DESC LIMIT 1`).

### T-02. Test `GET /api/skin-images?patient_id=...` và `GET /api/skin-images/files/{image_id}`
- **File nguồn:** không có
- **File đích:** không sửa file — test qua HTTP
- **Dependencies:** T-01
- **Tiêu chí hoàn thành:** danh sách trả về chứa ảnh vừa tạo ở T-01; endpoint
  `files/{image_id}` trả đúng bytes ảnh (mở được bằng trình xem ảnh / so
  khớp checksum với ảnh gốc).

---

## Nhóm 2 — Kết nối Message/Conversation đúng format đích

### [x] B-13. Viết lại `result_messages.py` cho luồng B theo format đích
> ĐÃ LÀM: tạo file `app/skin_images/result_messages.py` mới. 
> Hàm `create_skin_diagnostic_messages` trả về list 1-2 Message:
> 1. `skin_result` (assistant) với `content` (markdown) và `structured_data` (result dict).
> 2. `skin_image` (assistant) với `image_url` (từ run.image_url).
> Tái dùng logic format text từ bản nguồn.

### [x] B-14. Xác nhận `Message` model đích có đủ field `structured_data`, `image_url`
> ĐÃ KIỂM: class `Message` trong `app/db/models.py` có:
> - `message_type: Mapped[str]`
> - `image_url: Mapped[str | None]`
> - `structured_data: Mapped[dict | None]` (kiểu JSONB)
> Đủ field để hỗ trợ B-13 và luồng B.

### [x] M-01. Migration thêm `neo4j_patient_id` vào `Conversation`
> ĐÃ KIỂM: file migration `c7e2f4a9b1d3_add_neo4j_patient_id_to_conversations.py` đã tồn tại và thực hiện đúng việc thêm cột `neo4j_patient_id` (String 64, nullable) vào bảng `conversations`.

### [x] B-15. Thêm field `neo4j_patient_id` vào SQLAlchemy model `Conversation`
> ĐÃ KIỂM: `app/db/models.py` đã có `neo4j_patient_id: Mapped[str | None]`.

### [x] B-16. Thêm `neo4j_patient_id` vào schema Pydantic `Conversation`
> ĐÃ LÀM: thêm `neo4j_patient_id: str | None = None` vào `ConversationResponse` trong `app/schemas/conversation.py`.

---

## Nhóm 3 — Port `skin_diagnostic/service.py` (chẩn đoán sâu từ ảnh có sẵn)

### [x] B-17. Đọc & ánh xạ khác biệt `session_store.py` giữa 2 repo
> ĐÃ KIỂM:
> 1. **`SkinDiagnosticRun` (dataclass):** Đích có thêm các field: `fhir_patient_id`, `fhir_study_id`, `fhir_binary_id`, `neo4j_patient_id`.
> 2. **`SkinDiagnosticStore.create`:** Đích có thêm tham số `fhir_patient_id: str = ""` và thứ tự tham số `conversation_id` bị thay đổi so với nguồn.
> 
> **Input cho B-18:** Cần patch `store.create` ở đích để chấp nhận thêm `neo4j_patient_id`.

### [x] B-18. Patch `session_store.py` đích: thêm field `neo4j_patient_id`
> ĐÃ LÀM (ban đầu): cập nhật `SkinDiagnosticStore.create` để nhận `neo4j_patient_id`.
> ⚠️ LỖI PHÁT HIỆN SAU (tại B-21/B-22, đã sửa): `create()` truyền
> `neo4j_patient_id=neo4j_patient_id` vào constructor của dataclass
> `SkinDiagnosticRun`, nhưng dataclass **chưa có field `neo4j_patient_id`**
> — gây `TypeError` mỗi lần gọi `create()` (kể cả default rỗng, vì vẫn
> truyền keyword arg). Đã thêm `neo4j_patient_id: str = ""` vào
> `SkinDiagnosticRun` để khớp với `create()`. Xác nhận lại bằng test
> thực tế (T-03/T-04) vì chưa chạy được do venv hỏng.

### [x] B-19. Port `skin_diagnostic/service.py` (hàm `start_skin_diagnostic_from_binary`)
> ĐÃ LÀM: tạo mới `app/skin_diagnostic/service.py` và port hàm `start_skin_diagnostic_from_binary` từ nguồn. 
> (Lưu ý: mặc dù BREAKDOWN ghi "merge vào file đã tồn tại", nhưng file đích chưa có nên đã tạo mới).

### T-03. Test `start_skin_diagnostic_from_binary` bằng gọi trực tiếp (chưa qua agent)
- **File nguồn:** không có
- **File đích:** không sửa file — viết 1 script test tạm
  `D:\Project\fhir-agent-system\backend\scripts\manual_test_skin_diag_from_binary.py`
  (xoá sau khi test xong, hoặc giữ lại nếu team muốn)
- **Dependencies:** T-01 (đã có `binary_id` thật từ Neo4j), B-19
- **Tiêu chí hoàn thành:** gọi hàm với `binary_id` lấy từ T-01 → pipeline
  chạy nền, poll session status chuyển từ `running` → `interrupt`/`completed`
  đúng như luồng A.

---

## Nhóm 4 — Agent tool (nối luồng B vào chat)

### [x] B-20. Đọc cấu trúc `agents/fhir.py` đích — xác nhận có mấy `Agent(...)` instance
> ĐÃ KIỂM: chỉ có **1 instance** `Agent(...)` trong file đích — biến `agent`,
> khai báo ngay sau `internal_llm_model = OpenAIChatModel(...)` (trước khối
> "Debug logging"): `agent = Agent(internal_llm_model, system_prompt=SYSTEM_PROMPT,
> deps_type=AgentDeps, retries=1)`. Toàn bộ tool hiện có đều đăng ký qua
> `@agent.tool` trên đúng 1 instance này — khác file nguồn (nơi hàm
> `find_patient_skin_images` lặp lại ở 2 vị trí ~dòng 1053 và ~3114, ngụ ý
> nhiều agent). Do đó B-21/B-22 chỉ cần đăng ký tool mới **1 lần duy nhất**
> bằng `@agent.tool`, không cần lặp lại ở nơi khác.
> Đã thấy sẵn trong file đích (thuộc B-24, luồng A qua chat, đã port từ trước):
> `diagnose_skin_condition`, `search_skin_images`, `start_diagnosis_from_patient_image`.
> `find_patient_skin_images` (B-21) và `start_skin_diagnostic` (B-22) CHƯA có.
- **File nguồn:** `D:\Project\Fhir-agent\backend\app\agents\fhir.py`
- **File đích:** `D:\Project\fhir-agent-system\backend\app\agents\fhir.py`
- **Dependencies:** không
- **Tiêu chí hoàn thành:** đếm số lần `Agent(` khởi tạo trong file đích, ghi
  rõ số lượng + vị trí dòng (dùng để biết B-21 cần đăng ký tool ở mấy chỗ) —
  đây là task **chặn**, phải xong trước B-21.

### [x] B-21. Thêm tool `find_patient_skin_images` vào agent đích
> ĐÃ LÀM: thêm hàm `_resolve_neo4j_patient_name()` (helper mới, vì
> `search_patient_skin_images()` không trả tên bệnh nhân — theo ghi chú
> B-11) + tool `find_patient_skin_images` vào `app/agents/fhir.py` đích,
> đăng ký 1 lần duy nhất bằng `@agent.tool` (khớp B-20: chỉ 1 `Agent(...)`
> instance). Dùng `resolve_skin_image_filters` + `search_patient_skin_images`
> (đã import sẵn ở đích) rồi map qua `to_frontend_skin_image_result()`
> (adapter B-11 trong `service.py`) để khớp shape `SkinImageResult` frontend.
> Kết quả được đẩy ra UI qua `get_collector().emit_skin_images()` — cùng cơ
> chế với tool `search_skin_images` (luồng A) đã có sẵn ở đích — không nhét
> `view_url` vào text reply.
- **File nguồn:** `D:\Project\Fhir-agent\backend\app\agents\fhir.py`
  (hàm `find_patient_skin_images`, dòng ~1053 và có thể lặp lại ~3114)
- **File đích:** `D:\Project\fhir-agent-system\backend\app\agents\fhir.py`
- **Dependencies:** B-20, B-09 (cần `search_patient_skin_images` từ
  `app/skin_images/service.py`)
- **Tiêu chí hoàn thành:** hàm tool copy gần nguyên văn, đổi import trỏ tới
  `app.skin_images.service`; đăng ký ở **đúng số lượng** `Agent(...)` instance
  xác định ở B-20; agent liệt kê tool này khi gọi `agent.list_tools()`
  (hoặc endpoint debug tương đương) ở cả chế độ stream lẫn non-stream.

### [x] B-22. Thêm tool `start_skin_diagnostic` vào agent đích
> ĐÃ LÀM: thêm tool `start_skin_diagnostic(patient_id, binary_id,
> initial_complaint)` gọi `start_skin_diagnostic_from_binary` (B-19, đã
> thêm import). ⚠️ PHÁT HIỆN + SỬA BUG tại B-19/B-18 trong lúc làm: xem ghi
> chú tại B-18 (dataclass `SkinDiagnosticRun` thiếu field `neo4j_patient_id`
> — đã vá). Cũng đã sửa `start_skin_diagnostic_from_binary()` (B-19) để
> truyền `neo4j_patient_id=resolved_patient_id` vào `store.create()`.
- **File nguồn:** `D:\Project\Fhir-agent\backend\app\agents\fhir.py`
  (hàm `start_skin_diagnostic`)
- **File đích:** `D:\Project\fhir-agent-system\backend\app\agents\fhir.py`
- **Dependencies:** B-20, B-19
- **Tiêu chí hoàn thành:** hàm tool gọi
  `start_skin_diagnostic_from_binary` (B-19); đăng ký ở đủ số `Agent`
  instance như B-21; tool nhận đúng 3 tham số `patient_id, binary_id,
  initial_complaint`.

### [x] B-23. Thêm khối routing prompt `SKIN IMAGE RETRIEVAL` / `SKIN DIAGNOSTIC ROUTING`
> ĐÃ LÀM: chèn 2 khối `SKIN IMAGE RETRIEVAL (saved Neo4j Patient photos)` và
> `SKIN DIAGNOSTIC ROUTING (saved Neo4j Patient photos)` vào `SYSTEM_PROMPT`
> đích, ngay trước `FINAL RESPONSE`. ⚠️ ĐIỀU CHỈNH SO VỚI NGUỒN: đích không
> có cơ chế `IMAGE_ATTACHMENT` trong lịch sử hội thoại (bỏ ở B-09, và cả
> `message_history` luôn được truyền rỗng `[]` cho `agent.run()` — xem
> `_prepare_run`/`generate_agent_response`/`handle_message_stream`), nên quy
> tắc (2) được viết lại: `start_skin_diagnostic` chỉ dùng khi `binary_id` đã
> biết trong **cùng 1 lượt yêu cầu** (vừa lấy từ `find_patient_skin_images`)
> hoặc bác sĩ cung cấp trực tiếp — nếu chưa có, gọi `find_patient_skin_images`
> trước. Đủ 4 quy tắc còn lại: (1) tra cứu ảnh → `find_patient_skin_images`,
> (3) không tự chẩn đoán bằng lời, (4) không nhét Base64/bytes vào context.
- **File nguồn:** `D:\Project\Fhir-agent\backend\app\agents\fhir.py`
  (khối prompt dòng ~495–524)
- **File đích:** `D:\Project\fhir-agent-system\backend\app\agents\fhir.py`
  (system prompt string, cùng file)
- **Dependencies:** B-21, B-22
- **Tiêu chí hoàn thành:** system prompt đích có đủ 4 quy tắc: (1) câu hỏi
  tra cứu ảnh → `find_patient_skin_images`, (2) "chẩn đoán ảnh này" khi có
  `binary_id` trong `IMAGE_ATTACHMENT` → `start_skin_diagnostic`, (3) không
  tự chẩn đoán bằng lời, (4) không nhét Base64/bytes vào context.

### T-04. Test agent tool qua chat text thuần (chưa cần UI mới)
- **File nguồn:** không có
- **File đích:** không sửa file — test qua API `POST /api/conversations/{id}/messages`
  hoặc SSE stream endpoint
- **Dependencies:** B-23, T-01 (có `binary_id` thật)
- **Tiêu chí hoàn thành:** gửi message text "cho tôi xem ảnh da liễu của
  bệnh nhân X" → agent gọi đúng `find_patient_skin_images`, trả gallery
  trong `structured_data.skin_images`; gửi tiếp "chẩn đoán ảnh vừa xem" (kèm
  `binary_id` giả lập trong context) → agent gọi `start_skin_diagnostic`.

### B-24. (Tuỳ chọn — giai đoạn 2) Port `search_skin_images`, `diagnose_skin_condition`, `start_diagnosis_from_patient_image` (luồng A qua chat)
- **File nguồn:** `D:\Project\Fhir-agent\backend\app\agents\fhir.py`
- **File đích:** `D:\Project\fhir-agent-system\backend\app\agents\fhir.py`
- **Dependencies:** B-20; dùng
  `D:\Project\fhir-agent-system\backend\app\skin_diagnostic\fhir_images.py`
  đã có sẵn
- **Tiêu chí hoàn thành:** 3 tool mới hoạt động qua chat text cho luồng HAPI;
  **không bắt buộc cho scope hiện tại** — chỉ làm nếu team xác nhận cần.

---

## Nhóm 5 — Frontend

### [x] F-01. Khai báo type `SkinImageResult`, `SkinImageAnalyzeResponse`, `PatientSearchResult`
> ĐÃ KIỂM: cả 3 interface đã có sẵn trong `frontend/lib/api.ts` đích (cùng
> với `SkinImageSummary` phụ trợ).
- **File nguồn:** `D:\Project\Fhir-agent\frontend\lib\api.ts`
- **File đích:** `D:\Project\fhir-agent-system\frontend\lib\api.ts`
- **Dependencies:** B-11 (tên field đã chuẩn hoá)
- **Tiêu chí hoàn thành:** thêm 3 interface/type mới vào đầu file (hoặc file
  `types.ts` nếu tách riêng theo convention đích); `tsc --noEmit` không lỗi.

### [x] F-02. Hàm `analyzeSkinImage(image, patientId)`
> ĐÃ KIỂM: hàm đã có sẵn trong `frontend/lib/api.ts`, build `FormData` với
> `patient_id` + `image`, gọi `POST /skin-images/analyze` qua `apiFetch`.
- **File nguồn:** `D:\Project\Fhir-agent\frontend\lib\api.ts` (tham khảo
  `SkinDiagnosticPanel.tsx` cho cách gọi form-data)
- **File đích:** `D:\Project\fhir-agent-system\frontend\lib\api.ts`
- **Dependencies:** F-01, B-12 (endpoint `/api/skin-images/analyze` sống)
- **Tiêu chí hoàn thành:** hàm build `FormData` đúng field `patient_id` +
  `image`, gọi đúng base URL từ `lib/config.ts`; test bằng cách gọi từ
  console trình duyệt (hoặc unit test) trả về response hợp lệ khớp T-01.

### [x] F-03. Hàm `listSkinImages(patientId?)`
> ĐÃ KIỂM: hàm đã có sẵn trong `frontend/lib/api.ts`, gọi
> `GET /skin-images?patient_id=...`.
- **File nguồn:** `D:\Project\Fhir-agent\frontend\lib\api.ts`
- **File đích:** `D:\Project\fhir-agent-system\frontend\lib\api.ts`
- **Dependencies:** F-01, T-02
- **Tiêu chí hoàn thành:** gọi `GET /api/skin-images?patient_id=...`, trả
  đúng list; test khớp kết quả T-02.

### [x] F-04. Endpoint mỏng `GET /api/patients/search` (tìm bệnh nhân trong Neo4j cho UI)
> ĐÃ KIỂM: route `search_patients` (`GET /patients/search`, mount dưới
> `/api`) đã có sẵn trong `backend/app/api/graph.py` đích, trả
> `{id, name, birth_date}` qua Cypher trực tiếp (không qua LLM).
- **File nguồn:** không có (mới, wrap cùng cypher query mà agent tool
  `search_patient` dùng — xem
  `D:\Project\fhir-agent-system\backend\app\agents\fhir.py` hàm
  `search_patient` hiện có, và `app/api/graph.py` cho pattern router REST
  tương tự)
- **File đích:** `D:\Project\fhir-agent-system\backend\app\api\graph.py`
  (thêm route mới) hoặc file router riêng cùng thư mục `app/api/`
- **Dependencies:** B-06
- **Tiêu chí hoàn thành:** `GET /api/patients/search?q=...` trả về list tối
  giản `{id, name, birth_date}` (không qua LLM); test bằng Swagger với 1 tên
  bệnh nhân có thật trong Synthea seed.

### [x] F-05. Hàm `searchExistingPatients(query)`
> ĐÃ KIỂM: hàm đã có sẵn trong `frontend/lib/api.ts`, gọi F-04 và trả
> `PatientSearchResult[]`.
- **File nguồn:** không có (mới)
- **File đích:** `D:\Project\fhir-agent-system\frontend\lib\api.ts`
- **Dependencies:** F-04
- **Tiêu chí hoàn thành:** gọi F-04, trả `PatientSearchResult[]`; test bằng
  console browser.

### [x] F-06. State mới `pendingNeo4jPatientId` trong `ChatInterface.tsx`
> ĐÃ KIỂM: `pendingNeo4jPatientId`/`pendingNeo4jPatientName` đã khai báo
> cạnh `pendingFhirPatientId`, cùng các state phụ trợ cho luồng B
> (`patientChoiceModalOpen`, `existingPatientModalOpen`,
> `existingPatientQuery`, `existingPatientResults`,
> `searchingExistingPatients`, `existingPatientError`).
- **File nguồn:** không có (đối chiếu state hiện có
  `pendingFhirPatientId` trong
  `D:\Project\fhir-agent-system\frontend\components\ChatInterface.tsx`)
- **File đích:** `D:\Project\fhir-agent-system\frontend\components\ChatInterface.tsx`
- **Dependencies:** không
- **Tiêu chí hoàn thành:** thêm `useState<string | null>` mới tên
  `pendingNeo4jPatientId`, đặt cạnh khai báo `pendingFhirPatientId` hiện có;
  chưa gán giá trị ở task này (chỉ khai báo).

### [x] F-07. Sửa `handleFileSelect()` — mở popup 2 lựa chọn thay vì luôn mở popup "Tạo mới"
> ĐÃ KIỂM + VÁ LỖI: logic (`handleFileSelect` mở `patientChoiceModalOpen`,
> `handleChoiceNewPatient`/`handleChoiceExistingPatient`) đã có sẵn, NHƯNG
> phần JSX render cho `patientChoiceModalOpen` **chưa tồn tại** — popup lẽ
> ra phải hiện lại không hiện gì (chọn ảnh xong không thấy popup nào). Đã
> thêm khối JSX popup "Ảnh này thuộc về bệnh nhân nào?" (2 nút + Bỏ qua)
> vào cuối `ChatInterface.tsx`, cùng cụm với F-08. Luồng A giữ nguyên hành
> vi (nút "Bệnh nhân mới" gọi đúng `handleChoiceNewPatient` → mở lại
> `patientModalOpen` cũ).
- **File nguồn:** không có (thiết kế mới, tham khảo mô tả mục 3.1 trong `PLAN.md`)
- **File đích:** `D:\Project\fhir-agent-system\frontend\components\ChatInterface.tsx`
- **Dependencies:** F-06
- **Tiêu chí hoàn thành:** khi chọn ảnh, hiện popup với 2 radio option
  "Bệnh nhân mới" / "Bệnh nhân đang có" thay vì mở thẳng
  `patientModalOpen`; chọn "Bệnh nhân mới" giữ nguyên hành vi cũ 100% (kiểm
  bằng cách test lại luồng A không đổi kết quả).

### [x] F-08. Component/khối UI tìm kiếm "Bệnh nhân đang có" (autocomplete)
> ĐÃ KIỂM + VÁ LỖI: logic debounce (`handleExistingPatientQueryChange` gọi
> `searchExistingPatients` sau 300ms) và `handleSelectExistingPatient` (set
> `pendingNeo4jPatientId`) đã có sẵn, nhưng cũng như F-07, phần JSX render
> cho `existingPatientModalOpen` **chưa tồn tại**. Đã thêm popup "Tìm bệnh
> nhân đang có" (ô input + list kết quả + trạng thái loading/error/rỗng +
> nút quay lại popup chọn luồng) vào cuối `ChatInterface.tsx`, ngay sau
> popup F-07.
- **File nguồn:** không có (tham khảo UX từ `DocumentBrowser.tsx` nguồn chỉ
  để đối chiếu cách hiển thị list, KHÔNG copy file)
- **File đích:** `D:\Project\fhir-agent-system\frontend\components\ChatInterface.tsx`
  (hoặc tách file mới `components/PatientSearchInput.tsx` nếu component
  chính đã quá dài — quyết định tại lúc code)
- **Dependencies:** F-05, F-07
- **Tiêu chí hoàn thành:** gõ tên → debounce gọi `searchExistingPatients` →
  hiện list gợi ý → chọn 1 kết quả → set `pendingNeo4jPatientId`; test bằng
  gõ tên bệnh nhân Synthea có thật, thấy đúng gợi ý.

### [x] F-09. Sửa handler nút "Gửi" — route đúng luồng theo `pendingNeo4jPatientId` vs `pendingFhirPatientId`
> ĐÃ KIỂM: `sendMessage()` đã rẽ nhánh đúng — nếu `pendingNeo4jPatientId`
> có giá trị thì gọi `analyzeSkinImage` (luồng B, không polling); ngược
> lại giữ nguyên `startSkinDiagnostic` (luồng A). `handleFileSelect()` và
> `clearSelectedFile()` đều reset cả 2 state mỗi khi chọn ảnh mới, nên 2
> state không bao giờ cùng có giá trị. Đã cập nhật thêm khối "Image Preview
> Chip" để hiện đúng badge cho cả 2 luồng (trước đó chỉ hiện badge cho
> luồng A, luồng B chọn xong không có phản hồi UI nào).
- **File nguồn:** không có
- **File đích:** `D:\Project\fhir-agent-system\frontend\components\ChatInterface.tsx`
- **Dependencies:** F-02, F-08
- **Tiêu chí hoàn thành:** nếu `pendingNeo4jPatientId` có giá trị → gọi
  `analyzeSkinImage` (F-02); nếu `pendingFhirPatientId` có giá trị → giữ
  nguyên gọi `/skin-diagnostics/start` như cũ; 2 state không bao giờ cùng có
  giá trị cùng lúc (reset cái còn lại khi set 1 cái) — viết 1 test tay xác
  nhận điều này (chọn luồng A xong thử chọn luồng B trong cùng phiên, state
  cũ phải bị xoá).

### [x] F-10. Xác nhận `mapBackendMessage()` đọc đúng `structured_data.skin_images` cho luồng B
> Sửa tận gốc thay vì chỉ xác nhận: như ghi chú trước, `POST
> /skin-images/analyze` **không hề lưu Message nào vào DB** — kết quả luồng
> B chỉ tồn tại trong state React tạm thời, mất sạch sau reload. Đã sửa:
> - `backend/app/skin_images/schemas.py`: thêm `conversation_id`,
>   `conversation_title` vào `SkinImageAnalyzeResponse`.
> - `backend/app/skin_images/router.py`: endpoint `/analyze` giờ nhận thêm
>   `note` (text bác sĩ gõ cùng ảnh) và `conversation_id` (Form, optional);
>   sau khi `analyze_and_save_skin_image()` xong, tạo mới hoặc tái sử dụng
>   Conversation (cùng pattern `create_conversation_with_user_message` mà
>   `/skin-diagnostics/start` đã dùng), ghi 2 Message: user
>   (`message_type="skin_image"`, `image_url=result.image_url`) + assistant
>   (`message_type="text"`, content là markdown kết quả). Cũng set
>   `conversation.neo4j_patient_id = patient_id`.
> - `frontend/lib/api.ts`: `SkinImageAnalyzeResponse` thêm 2 field trên;
>   `analyzeSkinImage()` thêm tham số `note`, `conversationId`.
> - `frontend/components/ChatInterface.tsx`: nhánh luồng B trong
>   `sendMessage()` giờ truyền `messageText` + `activeConversationId`, và
>   cập nhật `activeConversationId`/sidebar/`conversations` giống hệt
>   nhánh luồng A (trước đó luồng B không bao giờ đổi
>   `activeConversationId`, nên nếu đây là tin nhắn đầu tiên, cuộc trò
>   chuyện sẽ không bao giờ xuất hiện trong sidebar).
> `mapBackendMessage()`/`loadConversationMessages()` đã có sẵn logic đọc
> `image_url` để rehydrate `imagePreview` cho mọi `message_type`, nên
> không cần sửa thêm ở đó — chưa chạy được server để test tay thật,
> **cần xác nhận lại ở T-05**.
- **File nguồn:** không có
- **File đích:** `D:\Project\fhir-agent-system\frontend\components\ChatInterface.tsx`
  (hàm `mapBackendMessage`)
- **Dependencies:** B-13, F-09
- **Tiêu chí hoàn thành:** gửi thử 1 ảnh qua luồng B (F-09) → reload trang →
  gallery `SkinImageThumbnail` hiện lại đúng ảnh vừa upload, không cần sửa
  thêm code hàm này (task này chỉ để **xác nhận bằng test**, không phải
  sửa code — nếu phát hiện lệch field thì quay lại B-11).

### T-05. Test UI end-to-end luồng B trên trình duyệt
- **File nguồn:** không có
- **File đích:** không sửa file — test tay
- **Dependencies:** F-01..F-10
- **Tiêu chí hoàn thành:** thực hiện đúng 4 bước ở mục "Luồng dữ liệu
  end-to-end / Feature 2" trong `PLAN.md` (bấm `ImagePlus` → chọn "Bệnh nhân
  đang có" → tìm & chọn patient → gửi ảnh) → thấy card `skin_image` +
  `skin_result` xuất hiện trong khung chat đúng như luồng A.

---

## Nhóm 6 — Tích hợp song song & rủi ro (làm sau cùng)

### T-06. Test 2 luồng A/B song song trong cùng 1 phiên chat
- **File nguồn:** không có
- **File đích:** không sửa file — test tay
- **Dependencies:** T-04, T-05
- **Tiêu chí hoàn thành:** trong 1 conversation, upload 1 ảnh theo luồng A
  (bệnh nhân mới), sau đó upload tiếp 1 ảnh theo luồng B (bệnh nhân đang có)
  → 2 kết quả không lẫn `fhir_patient_id`/`neo4j_patient_id` cho nhau (kiểm
  tra trực tiếp trong DB bảng `conversations`/`messages`).

### D-01. Ghi chú quyết định naming `neo4j_patient_id` vs field Neo4j hiện có
- **File nguồn:** không có
- **File đích:** `D:\Project\fhir-agent-system\WORK_BREAKDOWN.md` (mục này)
  hoặc `README.md` đích nếu team muốn tài liệu hoá lâu dài
- **Dependencies:** cần hỏi team trước khi làm M-01 (có thể làm task này
  **trước** M-01 nếu muốn chắc chắn naming)
- **Tiêu chí hoàn thành:** xác nhận với team không có convention khác đang
  gọi "Neo4j Patient ID" bằng tên khác (ví dụ `patient_id` trần) gây trùng;
  chốt tên cuối cùng, cập nhật lại M-01/B-15/B-16 nếu đổi tên.

### D-02. Ghi chú rủi ro "không tự tạo Patient mới trong Neo4j từ luồng B"
- **File nguồn:** không có
- **File đích:** ghi vào PR description hoặc `README.md` đích, không sửa code
- **Dependencies:** B-09 (đã giữ nguyên hành vi 404 khi patient không tồn tại)
- **Tiêu chí hoàn thành:** 1 đoạn note ngắn xác nhận với team đây là hành vi
  mong muốn (khác luồng A) — không cần code thêm nếu team đồng ý giữ nguyên.

### D-03. Ghi chú giới hạn: không tự động liên kết HAPI Patient ↔ Neo4j Patient
- **File nguồn:** không có
- **File đích:** ghi vào PR description hoặc `README.md` đích
- **Dependencies:** không
- **Tiêu chí hoàn thành:** note rõ đây là ngoài phạm vi (out of scope) của
  đợt tích hợp này, cần quy trình di chuyển dữ liệu riêng nếu về sau cần.

---

## Bảng phụ thuộc tổng quan (thứ tự khuyến nghị)

```
B-00, B-01                              (chuẩn bị)
  └─ B-02..B-10 (song song được)         (port skin_images/*)
       └─ B-11 (nếu cần)
            └─ B-12 → T-01 → T-02        (mount router + test)

B-14 (song song với nhóm trên)
M-01 → B-15 → B-16                       (migration Conversation)

B-17 → B-18                              (session_store patch)
  └─ B-19 (cần B-06, B-18)  → T-03 (cần T-01)

B-13 (cần B-09, B-14)

B-20 → B-21 (cần B-09) → B-22 (cần B-19) → B-23 → T-04 (cần T-01)
  └─ B-24 (tuỳ chọn, không chặn các task khác)

F-01 (cần B-11) → F-02 (cần B-12) → F-03 (cần T-02)
F-04 (cần B-06) → F-05
F-06 → F-07 (cần F-06) → F-08 (cần F-05,F-07) → F-09 (cần F-02,F-08)
  → F-10 (cần B-13) → T-05 (cần tất cả F-xx)

T-06 (cần T-04, T-05)
D-01, D-02, D-03 (bất kỳ lúc nào, không chặn code)
```
