# Healthcare AI Agent System

Hệ thống thống nhất kết hợp **CyFHIR ETL Engine** (Chuyển đổi dữ liệu chuẩn HL7 FHIR sang Neo4j Graph Database) và **FHIR Clinical Agent Backend/Frontend** (Trí tuệ nhân tạo truy vấn tri thức y khoa đa tầng & hỗ trợ chẩn đoán lâm sàng).

---

## Lý do Hợp nhất & Điểm Cải tiến Chi tiết

Trướcs đây, để hệ thống có thể chạy được, bạn phải thao tác thủ công phức tạp qua 2 dự án riêng biệt:
1. Chạy thủ công dự án `Cyfhir_1` để khởi động Neo4j, nạp plugin Java CyFHIR, rồi chạy script đẩy dữ liệu FHIR/Synthea vào Neo4j.
2. Sau khi Neo4j có dữ liệu mới chuyển sang mở và khởi chạy dự án `Fhir-agent`.

**Giải pháp thống nhất trong dự án này:**
- **Khởi chạy duy nhất 1 câu lệnh (`docker compose up --build -d`):** Toàn bộ 7 dịch vụ chính (Neo4j, Postgres pgvector, Qdrant, Cyfhir Express, Auto-seeder, FastAPI Backend, Next.js Frontend) tự động khởi tạo theo đúng thứ tự phụ thuộc.
- **Tự động Hóa 100% Quy trình 7 Bước Thủ công Trước đây:**
  1. **Tự động nạp Plugin CyFHIR (`CyFHIR.jar`):** Plugin CyFHIR Java (51MB) cùng APOC và GDS đã được đóng gói sẵn trong `docker/Dockerfile.cyfhir-neo4j`, tự động kích hoạt khi Neo4j khởi động.
  2. **Chuẩn hóa Môi trường Express ETL:** Sử dụng Node 18 Alpine ổn định trong `docker/Dockerfile.express`.
  3. **Tích hợp Tự động Nạp từ FHIR Server (`/api/LoadAllResources`):** Trong `cyfhir-express`, các controller (`neo4jController.ts`, `router.ts`, `cypherController.ts`) đã tích hợp sẵn endpoint nạp toàn bộ 24.390 resources thuộc 22 resource types từ FHIR Server (`FHIR_SERVER_URL=http://172.16.12.230:8012/fhir`).
  4. **Xử lý Triệt để 3 Bug Chính:**
     - **Fix JSON Escape:** Xử lý ký tự thoát escape (`\`, `"`, `'`) đối với dữ liệu HTML/Binary.
     - **Fix URL Rewrite:** Tự động rewrite `next` link URL từ internal docker (`http://hapi-fhir:8080/fhir`) sang IP FHIR Server thực tế.
     - **Fix Binary Data lớn (~4MB/file):** Tự động lọc bỏ (strip) trường `data` và `text.div` siêu lớn trước khi gửi tới Neo4j, chia phân trang nhỏ gọn (100 - 500 records/trang).
  5. **Auto Data Seeding (`cyfhir-seed`):** Container `cyfhir-seed` tự động kích hoạt `/api/LoadAllResources` (hoặc nạp local bundles) ngay khi `cyfhir-express` sẵn sàng.
- **Chỉnh sửa codebase không cần Rebuild Docker (Hot-Reloading 100%):** Nhờ cơ chế Docker Volume Mount, bất kỳ thay đổi nào trong thư mục `backend/`, `frontend/`, hoặc `cyfhir-express/` sẽ tự động cập nhật ngay lập tức mà **không cần** gõ lại `docker compose up --build -d`.
- **Sắp xếp Port hệ thống ngăn nắp, rõ ràng, không xung đột.**

---

## Bảng Sắp xếp Cổng (Port Mapping gọn gàng)

| Dịch vụ Container | Công nghệ | Host Port (Bên ngoài) | Container Port | Mục đích sử dụng / Đường dẫn truy cập |
| :--- | :--- | :--- | :--- | :--- |
| **`frontend`** | Next.js 14 / React | **`3000`** | `3000` |  Giao diện Web Client Agent: `http://localhost:3000` |
| **`cyfhir-express`** | Express.js / TypeScript | **`3001`** | `3001` |  CyFHIR ETL API & Swagger: `http://localhost:3001/docs` |
| **`backend`** | FastAPI / Python 3.12 | **`8000`** | `8000` |  Clinical Agent Core API & Swagger: `http://localhost:8000/docs` |
| **`neo4j`** | Neo4j 4.2.7 + CyFHIR | **`7474`**, **`7687`** | `7474`, `7687` |  Neo4j Graph Browser: `http://localhost:7474` (Bolt: `7687`) |
| **`postgres`** | PostgreSQL 17 + pgvector | **`5432`** | `5432` |  PostgreSQL Database (Mem0 Vector Store for Agent) |
| **`qdrant`** | Qdrant Vector Engine | **`6333`**, **`6334`** | `6333`, `6334` |  Clinical & Disease Symptom Vector Store API |
| **`cyfhir-seed`** | Alpine / Curl script | *(N/A)* | *(N/A)* |  Tự động nạp dữ liệu Synthea Bundles vào Neo4j rồi tự tắt |

---

## Hướng dẫn Khởi chạy Hệ thống

### 1. Yêu cầu Môi trường
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (Đã bật WSL 2 Backend trên Windows).

### 2. Khởi động 1 Câu lệnh Duy nhất
Mở Terminal / PowerShell tại thư mục `D:\Project\fhir-agent-system` và chạy:

```bash
docker compose up --build -d
```
*(Hoặc dùng Makefile tiện ích: `make up`)*

### 3. Quy trình Tự động Khởi tạo diễn ra ngầm:
1. `postgres` (pgvector) & `qdrant` khởi động và kiểm tra Healthcheck.
2. `neo4j` khởi tạo cùng plugin `CyFHIR.jar`, `apoc`, và `gds`.
3. `cyfhir-express` kết nối tới Neo4j qua cổng Bolt `7687`.
4. `cyfhir-seed` phát hiện `cyfhir-express` đã sẵn sàng -> Tự động đẩy toàn bộ 22 tập file Synthea FHIR Bundles (`data/synthea-bundles/*.json`) vào Neo4j.
5. `backend` (FastAPI) kết nối đồng thời với Neo4j, Postgres, và Qdrant.
6. `frontend` (Next.js) khởi tạo và sẵn sàng phục vụ người dùng tại `http://localhost:3000`.

---

## Cơ chế Hot-Reloading khi Chỉnh sửa Codebase

Bạn **KHÔNG NÊN** và **KHÔNG CẦN** gõ lại `docker compose up --build -d` mỗi khi chỉnh sửa code. Hệ thống đã được cấu hình Volume Bind Mounts như sau:

| Thư mục Code | Loại Hot-Reload | Cơ chế hoạt động ngầm |
| :--- | :--- | :--- |
| **`./backend`** | Python Auto-Reload | `uvicorn app.main:app --reload` theo dõi mọi file `.py` thay đổi và tự khởi động lại worker lập tức. |
| **`./frontend`** | Next.js HMR (Fast Refresh) | `npm run dev` tự phát hiện thay đổi trong `.tsx`, `.jsx`, `.css` và làm mới giao diện trình duyệt tức thì. |
| **`./cyfhir-express`**| Nodemon Live-Reload | `nodemon` theo dõi thư mục `src/` và tự compile/restart TypeScript server. |

---

## Cấu trúc Thư mục Dự án

```text
D:\Project\fhir-agent-system/
├── backend/                  # Mã nguồn FastAPI Python (Context Graph Reasoning Engine)
├── frontend/                 # Mã nguồn Next.js Web Application (React Chat Interface)
├── cyfhir-express/           # Mã nguồn Node.js/Express API (ETL Transformer & CyFHIR Router)
├── cyfhir-plugin/            # Plugin Java CyFHIR & binary jar cho Neo4j
├── data/
│   ├── synthea-bundles/      # Tập dữ liệu mẫu Synthea FHIR Bundles (dùng nạp tự động)
│   └── fhir-agent/           # Ontology & JSON Fixtures của Agent
├── docker/
│   ├── postgres/
│   │   └── init.sql          # Khởi tạo extension pgvector cho PostgreSQL
│   ├── scripts/
│   │   └── seed-neo4j.sh     # Script tự động nạp dữ liệu vào Neo4j
│   ├── Dockerfile.cyfhir-neo4j
│   ├── Dockerfile.express
│   ├── Dockerfile.backend
│   └── Dockerfile.frontend
├── docker-compose.yml        # Cấu hình Docker Compose thống nhất 7 services
├── .env                      # File cấu hình biến môi trường
├── Makefile                  # Các lệnh tắt quản lý hệ thống
└── README.md                 # Tài liệu hướng dẫn hệ thống
```

---

## Kiểm tra & Nghiệm thu Hệ thống

Sau khi khởi chạy `docker compose up --build -d`:

1. **Kiểm tra Graph Database (Neo4j):**
   - Truy cập: `http://localhost:7474`
   - Đăng nhập: Authentication type `No authentication` (hoặc User `neo4j` / Password `password`).
   - Chạy câu truy vấn Cypher thử nghiệm:
     ```cypher
     MATCH (p:Resource {resourceType: 'Patient'}) RETURN count(p);
     ```
   - Kết quả sẽ hiển thị hàng ngàn bệnh nhân cùng liên kết Conditions, Encounters đã được nạp tự động.

2. **Kiểm tra Cyfhir Express API:**
   - Truy cập Swagger UI: `http://localhost:3001/docs`

3. **Kiểm tra Backend API (FastAPI):**
   - Truy cập Swagger UI: `http://localhost:8000/docs`

4. **Trải nghiệm Giao diện Client (Next.js):**
   - Truy cập Web App: `http://localhost:3000`
   - Bắt đầu trò chuyện và truy vấn thông tin y khoa / bệnh án lâm sàng.

---

## Lệnh Tiện ích (Makefile / Docker Commands)

Dự án cung cấp `Makefile` giúp thao tác nhanh:

- **Khởi chạy hệ thống:**
  ```bash
  make up
  ```
- **Xem logs thời gian thực của tất cả container:**
  ```bash
  make logs
  ```
- **Kiểm tra trạng thái các container:**
  ```bash
  make ps
  ```
- **Chạy lại việc nạp dữ liệu thủ công (nếu cần):**
  ```bash
  make seed
  ```
- **Tắt toàn bộ hệ thống:**
  ```bash
  make down
  ```
- **Dừng hệ thống và xoá sạch dữ liệu cache/volumes:**
  ```bash
  make clean
  ```
