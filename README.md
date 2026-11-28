# CERBERUS-X

CERBERUS-X is an offline multimodal forensic intelligence and conflict-aware evidence graph engine. It inspects PDFs, CSV/TSV/Parquet tables, scanned documents, and images locally before any LLM sees them, extracts provenance-bound atomic claims, distinguishes temporal amendments (`SUPERSEDES`) from true contradictions (`CONTRADICTS`), and enforces a deterministic `0.65` abstention gate.

---

## Key Features

- **Pre-LLM Security Forensics (`core/forensics.py`):** Computes deterministic `SHA-256` source IDs (`src_<sha256[:12]>`), detects localized JPEG Error Level Analysis tampering (`32x32` blocks, threshold `25.0`), filters hidden PDF spans (white/near-white color, tiny `<= 5.0` font, off-page bounding boxes), inspects PDF/EXIF metadata, checks Laplacian blur (`< 80.0`), flags missing table cells (`MISSING_FIELD`), and strips prompt-injection clauses before chunk emission.
- **Multimodal Ingestion (`core/ingest.py`):** Extracts bounding-boxed OCR chunks via offline `RapidOCR`, table rows via `Pandas` and `DuckDB`, PDF text blocks via `PyMuPDF`, and plain-text/JSON spans with exact `LocationRef` coordinates (`page`, `row`, `column`, `bbox`, `char_span`), with optional local Ollama VLM summaries (`--use-vlm`).
- **Atomic Claim Extraction & Entity Resolution (`core/extractor.py`):** Rejects any chunk with `sanitized=False`. Extracts Pydantic v2 `Claim` records via deterministic rules or schema-constrained local Ollama (`qwen2.5:3b`) and resolves aliases across modalities using regex canonicalization, `RapidFuzz` clustering, optional offline `BAAI/bge-m3` embeddings, and optional Ollama tie-breaking.
- **Evidence Graph & Trust Propagation (`core/graph_engine.py`):** Builds a NetworkX `MultiDiGraph` of `Source`, `Claim`, and `Entity` nodes (`ASSERTS`, `ABOUT`, `SUPPORTS`, `CONTRADICTS`, `SUPERSEDES`). Evaluates temporal amendments first so legal updates do not incur contradiction penalties, then runs 5 trust-propagation iterations while capping quarantined claims at `0.15`.
- **Bounded Retrieval & Deterministic Abstention (`core/reasoner.py`):** Performs 2-hop bounded BFS (`get_entity_subgraph`) with optional offline `ChromaDB` entity hints and enforces `ABSTENTION_THRESHOLD = 0.65` in Python across `VERIFIED`, `CONFLICT_RESOLVED`, `TAMPER_DETECTED`, and `INSUFFICIENT_EVIDENCE`. Optional local Ollama synthesis acts strictly as a prose scribe over the verified `EvidenceDossier`.
- **Headless CLI & Local Web Audit Console (`cli.py`, `landing/`):** Provides full JSON CLI workflows plus a localhost HTTP server (`landing/server.py` on port `8503`) serving the overview page (`/`), Audit Console (`/audit.html`), live document upload/deletion (`data/raw/`), Pillow visual bounding-box proofs, and inline offline `PyVis` graphs.

---

## Tech Stack

| Layer | Technologies |
| --- | --- |
| Runtime & Validation | Python 3.13, Pydantic v2 (`>=2.7`), `python-dotenv` |
| Forensics & Parsing | PyMuPDF, RapidOCR (`rapidocr-onnxruntime`), Pillow, NumPy, Pandas, DuckDB |
| Graph & Entity Resolution | NetworkX (`MultiDiGraph`), RapidFuzz, PyVis (inline offline HTML) |
| Local AI & Retrieval | Ollama (`qwen2.5:3b`, optional `qwen2.5vl:7b`), `sentence-transformers` (`BAAI/bge-m3`), `transformers` + `torch` (`MoritzLaurer/DeBERTa-v3-base-mnli-fever-anli`), ChromaDB |
| Web Frontend & Server | Python `ThreadingHTTPServer`, vanilla HTML/CSS/JS (`landing/`) |
| Testing | `pytest` |

---

## Project Structure

```text
.
├── cli.py                      # Headless CLI entrypoint (ingest, extract, build-graph, query, eval)
├── core/
│   ├── config.py               # Centralized paths, thresholds, and local model settings
│   ├── schemas.py              # Pydantic v2 stage-boundary contracts
│   ├── forensics.py            # Pre-LLM ELA, hidden PDF text, blur, EXIF, and injection checks
│   ├── ingest.py               # Multimodal parser (PDF, tables, OCR scans/images, text/JSON)
│   ├── extractor.py            # Atomic claim extraction and 3-tier entity resolution
│   ├── graph_engine.py         # NetworkX evidence graph, edge detection, and trust propagation
│   └── reasoner.py             # 2-hop BFS retrieval, deterministic 0.65 abstention, eval runner
├── landing/
│   ├── server.py               # Local HTTP server and JSON API (127.0.0.1:8503)
│   ├── index.html              # System overview page
│   ├── audit.html              # Interactive Local Audit Console
│   ├── script.js               # Landing animations and page transitions
│   ├── audit.js                # Audit Console state, upload/delete, query, and graph wiring
│   └── style.css               # Monochromatic design system
├── data/
│   ├── synthetic_traps/        # 6 deterministic adversarial test files
│   └── raw/                    # User-uploaded runtime corpus directory
├── eval/
│   └── test_cases.json         # 5-case adversarial evaluation suite (TC-01 to TC-05)
├── scripts/
│   └── generate_traps.py       # Generator for data/synthetic_traps/
├── storage/                    # Generated pipeline JSON artifacts and ChromaDB directory
├── tests/                      # Unit, integration, open-domain, and HTTP server tests
├── .env.example                # Environment variable template
└── requirements.txt            # Python dependencies
```

---

## Prerequisites & Setup

### Prerequisites

- Python 3.10+ (tested on Python 3.13)
- Optional: Local [Ollama](https://ollama.com/) running at `http://127.0.0.1:11434` with `qwen2.5:3b` (and `qwen2.5vl:7b` for `--use-vlm`). All pipeline stages run deterministically without Ollama when `--use-llm` / `--use-vlm` are not enabled.
- Optional: Cached local HuggingFace weights for `BAAI/bge-m3` and `MoritzLaurer/DeBERTa-v3-base-mnli-fever-anli` (`HF_HUB_OFFLINE=1`).

### Installation

```powershell
# 1. Create and activate a virtual environment
python -m venv .venv
.\.venv\Scripts\Activate.ps1

# 2. Install Python dependencies
pip install -r requirements.txt

# 3. Configure environment variables (optional; defaults match .env.example)
Copy-Item .env.example .env
```

### Environment Variables (`.env.example`)

| Variable | Default | Purpose |
| --- | --- | --- |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Local Ollama API host |
| `LLM_MODEL` | `qwen2.5:3b` | Local Ollama text model for extraction/synthesis |
| `VLM_MODEL` | `qwen2.5vl:7b` | Local Ollama vision model for `--use-vlm` |
| `EMBED_MODEL` | `BAAI/bge-m3` | Cached local embedding model for entity similarity |
| `NLI_MODEL` | `MoritzLaurer/DeBERTa-v3-base-mnli-fever-anli` | Cached local NLI model for `--use-nli` |
| `HF_HUB_OFFLINE` | `1` | Enforces offline HuggingFace Hub mode |
| `TRANSFORMERS_OFFLINE` | `1` | Enforces offline Transformers model loading |
| `CERBERUS_LANDING_PORT` | `8503` | Port for `landing/server.py` |

---

## Usage & Available Scripts

### 1. Run the Offline CLI Pipeline

```powershell
# Optional: regenerate synthetic adversarial trap files in data/synthetic_traps/
.\.venv\Scripts\python.exe scripts\generate_traps.py

# Stage 1: Pre-LLM forensics and multimodal ingestion
.\.venv\Scripts\python.exe cli.py ingest --input data\synthetic_traps

# Stage 2: Atomic claim extraction and cross-modal entity resolution
.\.venv\Scripts\python.exe cli.py extract

# Stage 3: Build NetworkX evidence graph and run 5 rounds of trust propagation
.\.venv\Scripts\python.exe cli.py build-graph

# Stage 4: Query the evidence graph with deterministic abstention
.\.venv\Scripts\python.exe cli.py query "What is the approved amount for invoice INV-402?"

# Evaluate all 5 benchmark cases in eval/test_cases.json
.\.venv\Scripts\python.exe cli.py eval
```

Optional local AI flags:
- `cli.py ingest --use-vlm` (uses `VLM_MODEL` on images/scans)
- `cli.py extract --use-llm` (uses `LLM_MODEL` for claim extraction and entity tie-breaking)
- `cli.py build-graph --use-nli` (uses cached `NLI_MODEL` for free-text contradiction checks)
- `cli.py query "..." --use-llm --use-vector` (uses `LLM_MODEL` prose scribe and local ChromaDB hints)

### 2. Launch the Local Web Interface & Audit Console

```powershell
.\.venv\Scripts\python.exe landing\server.py
```

Open `http://127.0.0.1:8503` for the overview page and `http://127.0.0.1:8503/audit.html` for the Audit Console.

### 3. Run the Test Suite

Ensure `storage/` is populated with the `data/synthetic_traps` pipeline artifacts before running the full test suite:

```powershell
.\.venv\Scripts\python.exe cli.py ingest --input data\synthetic_traps
.\.venv\Scripts\python.exe cli.py extract
.\.venv\Scripts\python.exe cli.py build-graph
.\.venv\Scripts\pytest.exe -v
```

### 4. Benchmark Scenarios (`eval/test_cases.json`)

| Case ID | Scenario | Expected Verdict |
| --- | --- | --- |
| `TC-01` | Cross-modal conflict, ELA tamper, and prompt injection (`INV-402` amount) | `CONFLICT_RESOLVED` (`$12,000`) |
| `TC-02` | Temporal amendment resolution (`INV-510` amount) | `VERIFIED` (`$5,200`, `SUPERSEDES`) |
| `TC-03` | Blank ledger approver and blurred scan (`WIRE-Q4` approver) | `INSUFFICIENT_EVIDENCE` |
| `TC-04` | Clean corroborated lookup (`INV-402` vendor) | `VERIFIED` (`Apex Logistics`) |
| `TC-05` | Prompt injection resistance (`INV-402` vendor notes) | `TAMPER_DETECTED` |
