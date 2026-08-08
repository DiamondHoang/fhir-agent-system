# Healthcare AI Agent System

Hệ thống AI y tế hỗ trợ truy vấn đồ thị chuẩn HL7 FHIR (Neo4j) & chẩn đoán bệnh lâm sàng đa phương thức.  
Hệ thống tích hợp mô hình tri thức **POLE+ (People, Object, Location, Event + Extended)** giúp suy luận và truy vết đa nhảy (multi-hop graph tracing) trên cơ sở dữ liệu y tế.

---

## 1. Bảng Cổng Service (Port Mapping)

| Service | Công nghệ | Host Port | Mục đích |
|:---|:---|:---|:---|
| `frontend` | Next.js 14 | **3000** | Giao diện Chat Web cho người dùng (http://localhost:3000) |
| `cyfhir-express` | Express + TypeScript | **3001** | API chuyển đổi dữ liệu FHIR ETL (http://localhost:3001/docs) |
| `backend` | FastAPI + Python 3.12 | **8000** | REST API Clinical Agent & Swagger (http://localhost:8000/docs) |
| `neo4j` | Neo4j 4.2.7 + CyFHIR | **7474** / **7687** | Giao diện Neo4j Browser (http://localhost:7474) & Cổng Bolt |
| `postgres` | PostgreSQL 17 + pgvector | **5432** | Cơ sở dữ liệu lưu lịch sử hội thoại |
| `qdrant` | Qdrant | **6333** / **6334** | Vector Database tìm kiếm tri thức RAG |
| `cyfhir-seed` | Alpine / bash / curl | — | Tool nạp dữ liệu FHIR ban đầu (chạy 1 lần rồi dừng) |

---

## 2. Hướng dẫn Khởi chạy (Quick Start)

Dự án đã thiết lập sẵn file **`.env`** chuẩn ở thư mục gốc. Không cần copy từ `.env.example`.

> **Khuyên dùng (Tùy chọn):** Bạn có thể cài extension VS Code **DBCode - SQL & Database Client** (hoặc DBeaver/TablePlus) để dễ dàng xem và quản lý dữ liệu trong PostgreSQL (`localhost:5432`).

```bash
# Khởi chạy tất cả 7 services
docker compose up --build -d

# Xem log kiểm tra trạng thái
docker compose logs -f
```

---

## 3. Cấu hình Ollama trên Máy Host (Sửa lỗi kết nối Docker -> Ollama)

Nếu bạn chạy LLM qua **Ollama cài trên máy host** (`LLM_PROVIDER=ollama` trong file `.env`):

### 1. Tải 2 Model bắt buộc về Ollama:
Hệ thống cần 1 model LLM (suy luận/chat) và 1 model Embedding (RAG/Vector Search):
```bash
# Tải model LLM suy luận
ollama pull gemma4:31b-cloud

# Tải model Embedding vector
ollama pull bge-m3:latest
```

### 2. Mở cổng Binding & Cấu hình Xử lý Song song (Parallel Concurrency) cho Ollama:
1. **Chỉnh môi trường hệ thống:**
   - Mặc định Ollama chỉ mở cổng `127.0.0.1:11434` (chỉ máy host truy cập được, container Docker sẽ bị lỗi `Connection Refused`).
   - Cần thêm 2 biến môi trường hệ thống trên máy Host (Windows / Linux):  
     - `OLLAMA_HOST=0.0.0.0` *(Mở cổng kết nối cho Docker)*
     - `OLLAMA_NUM_PARALLEL=4` *(Cho phép Ollama phục vụ đồng thời 4 hội thoại song song mà không bị xếp hàng nghẽn)*
   - Sau đó khởi động lại ứng dụng Ollama Desktop / Service.
2. **Cấu hình địa chỉ URL trong `.env`:**
   - Trong file `.env`, URL đã được cấu hình trỏ tới `http://host.docker.internal:11434/v1` thay vì `localhost`.

---

## 4. Phân biệt & Xử lý Dữ Liệu Giả vs Dữ Liệu Thật

### So sánh Resource: Dữ liệu giả vs Dữ liệu thật
- **Dữ liệu giả (`data/synthea-bundles/`):** Chứa 22 file FHIR Bundle mẫu chuẩn từ Synthea. Cấu trúc JSON **hoàn toàn đầy đủ các Resource chuẩn y hệt Dữ liệu thật** (bao gồm `Patient`, `Encounter`, `Condition`, `Observation`, `MedicationRequest`, `Claim`, `CarePlan`, `Immunization`, `Organization`, `Practitioner`...).
- **Dữ liệu thật:** Lấy từ Server FHIR bệnh viện thật thông qua chuẩn REST API.

### Chuyển đổi giữa Dữ Liệu Giả và Dữ Liệu Thật

#### Cách 1: Sử dụng Dữ Liệu Giả (Mặc định)
- Để nguyên folder `data/synthea-bundles/`.
- Đặt `FHIR_SERVER_URL=` (để trống) trong `.env`.
- Chạy `make seed` (hoặc `docker compose --profile seed run --rm cyfhir-seed`) để đọc 22 file JSON trong `data/synthea-bundles/` nạp vào Neo4j khi cần.

#### Cách 2: Sử dụng Dữ Liệu Thật từ Server FHIR
1. Mở file `.env`, điền URL Server FHIR thật vào biến:
   ```env
   FHIR_SERVER_URL=http://your-fhir-server-ip:8012/fhir
   ```
2. (Tùy chọn) Xóa sạch các file JSON mẫu trong folder `data/synthea-bundles/`.
3. Chạy lệnh seed:
   ```bash
   make seed
   # hoặc: docker compose --profile seed run --rm cyfhir-seed
   ```
   Container `cyfhir-seed` sẽ gọi API `LoadAllResources` lấy dữ liệu thật trực tiếp từ Server FHIR về Neo4j.

---

## 5. Xóa Sạch Dữ Liệu & Reset Hệ Thống (Clean Data)

Khi cần xóa sạch toàn bộ dữ liệu chat, vector, graph database để làm mới hoàn toàn:

```bash
# Xóa toàn bộ container và các Docker Volumes chứa dữ liệu DB
docker compose down -v
# hoặc: make clean
```
