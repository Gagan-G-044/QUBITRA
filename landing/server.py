"""Unified offline HTTP server & API backend for CERBERUS-X.

Serves the Swiss minimalist frontend (`landing/index.html` and `landing/audit.html`)
alongside local JSON/HTML endpoints wired directly to `core/` — zero Streamlit dependency.
"""

from __future__ import annotations

import base64
import io
import json
import mimetypes
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse

import networkx as nx
import pandas as pd
from PIL import Image, ImageDraw
from pydantic import TypeAdapter
import pymupdf
from pyvis.network import Network

LANDING_DIR = Path(__file__).resolve().parent
BASE_DIR = LANDING_DIR.parent
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

from core.config import settings  # noqa: E402
from core.extractor import extract_and_persist  # noqa: E402
from core.graph_engine import build_and_persist_graph, load_graph_artifacts  # noqa: E402
from core.ingest import ingest_directory  # noqa: E402
from core.reasoner import answer_query  # noqa: E402
from core.schemas import (  # noqa: E402
    LocationRef,
    Modality,
    SourceDoc,
    VerdictResponse,
)

# Display-only badge mappings (keep internal Pydantic enums and JSON drawer untouched).
_EDGE_DISPLAY_MAP: dict[str, str] = {
    "CONTRADICTS": "CONFLICT",
    "SUPERSEDES": "UPDATED RECORD",
    "SUPPORTS": "MATCHES",
}

_FLAG_DISPLAY_MAP: dict[str, str] = {
    "ELA_TAMPER_DETECTED": "EDITED IMAGE (ELA)",
    "HIDDEN_PDF_TEXT": "HIDDEN WHITE TEXT",
    "PROMPT_INJECTION": "AI HIJACK ATTEMPT",
    "LOW_LEGIBILITY_BLUR": "BLURRY SCAN",
    "MISSING_FIELD": "BLANK FIELD",
}

# Tracks unsaved raw uploads/deletions in data/raw since last pipeline run.
_RAW_DIR_DIRTY: bool = False

_PROGRESS_LOCK = threading.Lock()
_PROGRESS_STATE: dict[str, Any] = {
    "active": False,
    "mode": "idle",
    "stage": 0,
    "title": "",
    "detail": "",
    "started_at": 0.0,
}


def _set_progress(active: bool, mode: str = "idle", stage: int = 0, title: str = "", detail: str = "") -> None:
    """Update live execution stage metadata safely across worker threads."""
    with _PROGRESS_LOCK:
        _PROGRESS_STATE["active"] = active
        _PROGRESS_STATE["mode"] = mode
        _PROGRESS_STATE["stage"] = stage
        _PROGRESS_STATE["title"] = title
        _PROGRESS_STATE["detail"] = detail
        if active and _PROGRESS_STATE["started_at"] <= 0.0:
            _PROGRESS_STATE["started_at"] = time.monotonic()
        elif not active:
            _PROGRESS_STATE["started_at"] = 0.0


def _get_progress() -> dict[str, Any]:
    """Snapshot current execution stage and elapsed time."""
    with _PROGRESS_LOCK:
        elapsed = (
            max(0.0, time.monotonic() - _PROGRESS_STATE["started_at"])
            if _PROGRESS_STATE["active"] and _PROGRESS_STATE["started_at"] > 0.0
            else 0.0
        )
        return {
            "active": _PROGRESS_STATE["active"],
            "mode": _PROGRESS_STATE["mode"],
            "stage": _PROGRESS_STATE["stage"],
            "title": _PROGRESS_STATE["title"],
            "detail": _PROGRESS_STATE["detail"],
            "elapsed_sec": round(elapsed, 2),
        }


def _display_flag(code: str) -> str:
    """Return human-readable label for a forensic flag code (display only)."""
    return _FLAG_DISPLAY_MAP.get(code, code)


def _display_edge(edge_type: str) -> str:
    """Return human-readable label for an epistemic edge type (display only)."""
    return _EDGE_DISPLAY_MAP.get(edge_type, edge_type)


def _summarize_forensic_flags(flags: list[Any]) -> tuple[str, list[tuple[str, int]], str]:
    """Group forensic flags by code in order of appearance into badges and one concise summary line."""
    if not flags:
        return "INFO", [], "Flagged during forensic screening."

    severities = [str(f.severity.value) for f in flags]
    top_severity = "CRITICAL" if "CRITICAL" in severities else severities[0]

    grouped: dict[str, list[Any]] = {}
    for flag in flags:
        grouped.setdefault(str(flag.code), []).append(flag)

    badge_counts = [(code, len(items)) for code, items in grouped.items()]

    if len(flags) == 1:
        return top_severity, badge_counts, str(flags[0].detail)

    clauses: list[str] = []
    for _code, items in grouped.items():
        if len(items) == 1:
            detail_txt = str(items[0].detail).strip().rstrip(".")
            if len(grouped) > 1 and ": '" in detail_txt:
                detail_txt = detail_txt.split(": '", 1)[0].strip()
            clauses.append(detail_txt)
            continue

        snippets: list[str] = []
        for item in items:
            raw_detail = str(item.detail)
            found = re.findall(r"'([^']+)'", raw_detail)
            if found:
                snip = found[-1]
                if snip not in snippets:
                    snippets.append(snip)
        if snippets:
            quoted = ", ".join(f"'{s}'" for s in snippets[:4])
            if len(snippets) > 4:
                quoted = f"{quoted}, +{len(snippets) - 4} more"
            clauses.append(f"{len(items)} matched patterns: {quoted}")
        else:
            first_prefix = str(items[0].detail).strip().rstrip(".")
            clauses.append(f"{len(items)} occurrences ({first_prefix})")

    summary = "; ".join(clauses)
    if summary and not summary.endswith("."):
        summary = f"{summary}."
    if len(summary) > 260:
        summary = f"{summary[:257].rstrip()}..."
    return top_severity, badge_counts, summary


def check_ollama_status(
    base_url: str | None = None,
    model_name: str | None = None,
    timeout: float = 1.5,
) -> tuple[bool, list[str]]:
    """Check whether local Ollama is reachable at `127.0.0.1:11434` and list models."""
    target_url = (base_url or settings.ollama_base_url).rstrip("/")
    target_model = model_name or settings.llm_model
    try:
        with urllib.request.urlopen(f"{target_url}/api/tags", timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        models = [str(m.get("name", "")) for m in data.get("models", []) if m.get("name")]
        has_model = any(
            m == target_model or m.startswith(f"{target_model}:") or target_model in m
            for m in models
        )
        return (has_model or bool(models)), models
    except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError, ValueError):
        return False, []


def run_full_pipeline(
    input_dir: Path,
    storage_dir: Path,
    use_llm: bool = False,
) -> dict[str, Any]:
    """Execute ingest -> extract -> build-graph sequentially and return summary counts."""
    docs, chunks = ingest_directory(input_dir=input_dir, storage_dir=storage_dir)
    claims, entity_map = extract_and_persist(storage_dir=storage_dir, use_llm=use_llm)
    graph, _, scored_claims, edges = build_and_persist_graph(storage_dir=storage_dir)
    return {
        "doc_count": len(docs),
        "chunk_count": len(chunks),
        "claim_count": len(scored_claims),
        "entity_count": len(entity_map),
        "total_nodes": graph.number_of_nodes(),
        "total_edges": graph.number_of_edges(),
        "epistemic_edge_count": len(edges),
    }


def _resolve_doc_path(file_path: str) -> Path:
    """Resolve stored relative or absolute document paths against BASE_DIR."""
    candidate = Path(file_path)
    if candidate.is_absolute():
        return candidate
    return (settings.base_dir / candidate).resolve()


def render_visual_proof(
    doc: SourceDoc,
    loc: LocationRef,
    highlight_color: str = "#DC2626",
) -> Image.Image | None:
    """Render a highlighted Pillow image for PDF/IMAGE/SCAN provenance; None for tables."""
    if doc.modality not in (Modality.IMAGE, Modality.SCAN, Modality.PDF):
        return None

    file_path = _resolve_doc_path(doc.file_path)
    if not file_path.exists():
        return None

    if doc.modality in (Modality.IMAGE, Modality.SCAN):
        with Image.open(file_path) as raw_img:
            canvas = raw_img.convert("RGB")
        if loc.bbox is not None:
            draw = ImageDraw.Draw(canvas)
            x0, y0, x1, y1 = loc.bbox
            pad = 3.0
            box = (
                max(0.0, x0 - pad),
                max(0.0, y0 - pad),
                min(float(canvas.width - 1), x1 + pad),
                min(float(canvas.height - 1), y1 + pad),
            )
            draw.rectangle(box, outline=highlight_color, width=4)
        return canvas

    dpi = 150
    zoom = dpi / 72.0
    pdf_doc = pymupdf.open(str(file_path))
    try:
        page_index = max(0, (loc.page or 1) - 1)
        if page_index >= len(pdf_doc):
            return None
        page = pdf_doc[page_index]
        pix = page.get_pixmap(dpi=dpi)
        canvas = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
    finally:
        pdf_doc.close()

    if loc.bbox is not None:
        draw = ImageDraw.Draw(canvas)
        x0, y0, x1, y1 = (coord * zoom for coord in loc.bbox)
        pad = 4.0
        box = (
            max(0.0, x0 - pad),
            max(0.0, y0 - pad),
            min(float(canvas.width - 1), x1 + pad),
            min(float(canvas.height - 1), y1 + pad),
        )
        draw.rectangle(box, outline=highlight_color, width=4)

    return canvas


def build_offline_pyvis_html(
    graph: nx.MultiDiGraph,
    highlight_entities: list[str] | None = None,
    height: str = "520px",
) -> str:
    """Build 100% offline self-contained PyVis HTML (`cdn_resources='in_line'`) in default semantic colors."""
    if highlight_entities:
        undirected = graph.to_undirected(as_view=True)
        keep_nodes: set[str] = set()
        for ent in highlight_entities:
            if ent in graph:
                keep_nodes.update(
                    nx.single_source_shortest_path_length(undirected, ent, cutoff=2).keys()
                )
        view_graph = graph.subgraph(keep_nodes) if keep_nodes else graph
    else:
        view_graph = graph

    net = Network(
        height=height,
        width="100%",
        directed=True,
        bgcolor="#FFFFFF",
        font_color="#111111",
        cdn_resources="in_line",
    )
    net.barnes_hut(gravity=-3500, central_gravity=0.35, spring_length=130)

    quarantined_sources: set[str] = {
        str(nid)
        for nid, attrs in view_graph.nodes(data=True)
        if attrs.get("node_type") == "Source" and bool(attrs.get("quarantined", False))
    }

    for node_id, attrs in view_graph.nodes(data=True):
        ntype = str(attrs.get("node_type", "Unknown"))
        nid_str = str(node_id)

        if ntype == "Entity":
            aliases = ", ".join(attrs.get("aliases", []))
            net.add_node(
                nid_str,
                label=nid_str,
                title=f"Entity: {nid_str}\nAliases: {aliases}",
                shape="diamond",
                color="#2563EB",
                size=24,
            )
        elif ntype == "Source":
            is_q = bool(attrs.get("quarantined", False))
            fname = str(attrs.get("file_name", nid_str))
            mod = str(attrs.get("modality", ""))
            rel = float(attrs.get("dynamic_reliability", attrs.get("trust_prior", 0.0)))
            flags = [str(f.get("code", "")) for f in attrs.get("forensic_flags", [])]
            flag_str = ", ".join(flags) if flags else "None"
            net.add_node(
                nid_str,
                label=f"{fname}\n[{mod}]",
                title=(
                    f"Source: {fname} ({mod})\n"
                    f"Reliability: {rel:.2f}\nQuarantined: {is_q}\nFlags: {flag_str}"
                ),
                shape="box",
                color="#DC2626" if is_q else "#0D9488",
                font={"color": "#FFFFFF"},
            )
        else:
            is_q_claim = str(attrs.get("source_id", "")) in quarantined_sources
            is_sup = bool(attrs.get("superseded", False))
            attr_name = str(attrs.get("attribute", "claim"))
            val = str(attrs.get("value", ""))
            trust = float(attrs.get("trust_score", 0.0))
            if is_q_claim:
                color = "#EA580C"
            elif is_sup:
                color = "#9CA3AF"
            else:
                color = "#16A34A"
            short_val = val if len(val) <= 22 else f"{val[:19]}..."
            net.add_node(
                nid_str,
                label=f"{attr_name}: {short_val}",
                title=(
                    f"Claim: {nid_str}\n{attr_name} = {val}\n"
                    f"Trust: {trust:.3f}\nSuperseded: {is_sup}"
                ),
                shape="dot",
                color=color,
                size=13 if is_sup else 16,
            )

    for u, v, _, data in view_graph.edges(keys=True, data=True):
        etype = str(data.get("edge_type", "REL"))
        reason = str(data.get("reason", etype))
        if etype == "SUPPORTS":
            net.add_edge(str(u), str(v), label="SUPPORTS", title=reason, color="#16A34A", width=2)
        elif etype == "CONTRADICTS":
            net.add_edge(
                str(u),
                str(v),
                label="CONTRADICTS",
                title=reason,
                color="#DC2626",
                width=3,
                dashes=True,
            )
        elif etype == "SUPERSEDES":
            net.add_edge(str(u), str(v), label="SUPERSEDES", title=reason, color="#D97706", width=2.5)
        else:
            net.add_edge(str(u), str(v), label=etype, title=reason, color="#D4D4D8", width=1)

    raw_html = str(net.generate_html())
    offline_html = re.sub(
        r"<link\b[^>]*href=[\"']https?://[^\"']+[\"'][^>]*>",
        "",
        raw_html,
        flags=re.IGNORECASE | re.DOTALL,
    )
    offline_html = re.sub(
        r"<script\b[^>]*src=[\"']https?://[^\"']+[\"'][^>]*>\s*</script>",
        "",
        offline_html,
        flags=re.IGNORECASE | re.DOTALL,
    )
    # Remove PyVis default card border so it nests cleanly inside the hairline frame
    offline_html = offline_html.replace(
        "<style type=\"text/css\">",
        "<style type=\"text/css\">\nbody{margin:0;padding:0;background:#ffffff;}\n#mynetwork{border:none !important;}\n",
        1,
    )
    return offline_html


def _load_ingested_docs(storage_dir: Path) -> list[SourceDoc]:
    """Load persisted SourceDoc records if available."""
    path = storage_dir / "ingested_docs.json"
    if not path.exists():
        return []
    return TypeAdapter(list[SourceDoc]).validate_json(path.read_text(encoding="utf-8"))


def _load_test_presets() -> list[dict[str, Any]]:
    """Load preset benchmark queries from eval/test_cases.json."""
    if not settings.eval_cases_path.exists():
        return []
    return list(json.loads(settings.eval_cases_path.read_text(encoding="utf-8")))


def _format_location(loc: LocationRef) -> str:
    """Format LocationRef concisely into an audit tag string."""
    parts: list[str] = []
    if loc.page is not None:
        parts.append(f"page={loc.page}")
    if loc.row is not None:
        parts.append(f"row={loc.row}")
    if loc.column:
        parts.append(f"col={loc.column}")
    if loc.bbox is not None and loc.row is None:
        coords = ",".join(str(int(round(c))) for c in loc.bbox)
        parts.append(f"bbox=({coords})")
    return " · ".join(parts) if parts else "source"


def _infer_active_corpus(docs: list[SourceDoc]) -> tuple[str, str]:
    """Infer currently indexed corpus directory path and canonical label."""
    if not docs:
        return "", "Not indexed"
    try:
        parent = _resolve_doc_path(docs[0].file_path).resolve().parent
        if parent == settings.synthetic_traps_dir.resolve():
            return str(settings.synthetic_traps_dir), "synthetic_traps"
        if parent == settings.data_raw_dir.resolve():
            return str(settings.data_raw_dir), "data/raw"
        return str(parent), parent.name
    except OSError:
        return "", "Indexed corpus"


def _count_visual_proofs(response: VerdictResponse, docs_by_id: dict[str, SourceDoc]) -> int:
    """Count matching visual and tabular proof items in Tab 2."""
    count = 0
    for cit in response.citations:
        doc = docs_by_id.get(cit.source_id)
        if doc is None:
            continue
        if _resolve_doc_path(doc.file_path).exists() and doc.modality in (
            Modality.TABLE,
            Modality.IMAGE,
            Modality.SCAN,
            Modality.PDF,
        ):
            count += 1
    for q_doc in response.quarantined_sources:
        if (
            q_doc.modality in (Modality.IMAGE, Modality.SCAN, Modality.PDF)
            and _resolve_doc_path(q_doc.file_path).exists()
        ):
            count += 1
    return count


def _list_raw_files(raw_dir: Path) -> list[dict[str, Any]]:
    """Return sorted uploaded file metadata dictionaries from data/raw/."""
    raw_dir.mkdir(parents=True, exist_ok=True)
    items: list[dict[str, Any]] = []
    for entry in sorted(raw_dir.iterdir(), key=lambda p: p.name.lower()):
        if not entry.is_file() or entry.name == ".gitkeep":
            continue
        ext = entry.suffix.lstrip(".").upper() or "FILE"
        items.append(
            {
                "name": entry.name,
                "size_bytes": int(entry.stat().st_size),
                "ext": ext,
            }
        )
    return items


def _sanitize_raw_filename(raw_name: str) -> str:
    """Validate uploaded or target deletion filename strictly against path traversal."""
    decoded = unquote(raw_name).strip()
    if (
        not decoded
        or "\x00" in decoded
        or "/" in decoded
        or "\\" in decoded
        or ".." in decoded
    ):
        raise ValueError("Invalid filename")
    safe = Path(decoded).name
    if safe != decoded or safe in ("", ".", "..", ".gitkeep"):
        raise ValueError("Invalid filename")
    return safe


def _image_to_data_uri(img: Image.Image) -> str:
    """Encode a PIL Image as an inline PNG data URI."""
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    encoded = base64.b64encode(buf.getvalue()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def _serialize_doc(doc: SourceDoc) -> dict[str, Any]:
    """Serialize SourceDoc with both raw metadata and summarized display flags."""
    top_sev, badge_counts, summary_line = _summarize_forensic_flags(doc.forensic_flags)
    return {
        "source_id": doc.source_id,
        "file_name": doc.file_name,
        "file_path": doc.file_path,
        "sha256": doc.sha256,
        "modality": str(doc.modality.value),
        "trust_prior": float(doc.trust_prior),
        "quarantined": bool(doc.quarantined),
        "top_severity": top_sev,
        "summary_line": summary_line,
        "flags": [
            {
                "code": str(code),
                "display": _display_flag(str(code)),
                "count": int(cnt),
            }
            for code, cnt in badge_counts
        ],
    }


def _build_visual_proofs(
    response: VerdictResponse,
    docs_by_id: dict[str, SourceDoc],
) -> list[dict[str, Any]]:
    """Build inline tabular and PIL bounding-box proof payloads."""
    proofs: list[dict[str, Any]] = []

    for idx, cit in enumerate(response.citations, start=1):
        doc = docs_by_id.get(cit.source_id)
        if doc is None:
            continue
        doc_path = _resolve_doc_path(doc.file_path)
        if not doc_path.exists():
            continue

        if doc.modality == Modality.TABLE:
            try:
                if doc.file_path.lower().endswith(".parquet"):
                    df = pd.read_parquet(doc_path)
                else:
                    df = pd.read_csv(doc_path)
                target_row = (cit.location_ref.row - 1) if cit.location_ref.row else -1
                safe_df = df.fillna("[MISSING]").astype(str)
                proofs.append(
                    {
                        "kind": "table",
                        "index": idx,
                        "file_name": doc.file_name,
                        "location": _format_location(cit.location_ref),
                        "quarantined": False,
                        "columns": list(safe_df.columns),
                        "rows": safe_df.values.tolist(),
                        "highlight_row": target_row,
                    }
                )
            except Exception:
                continue
        else:
            img = render_visual_proof(doc, cit.location_ref, highlight_color="#16A34A")
            if img is not None:
                proofs.append(
                    {
                        "kind": "image",
                        "index": idx,
                        "file_name": doc.file_name,
                        "location": f"Page {cit.location_ref.page or 1}",
                        "quarantined": False,
                        "data_uri": _image_to_data_uri(img),
                    }
                )

    for q_doc in response.quarantined_sources:
        if (
            q_doc.modality not in (Modality.IMAGE, Modality.SCAN, Modality.PDF)
            or not _resolve_doc_path(q_doc.file_path).exists()
        ):
            continue
        loc = next((f.location for f in q_doc.forensic_flags if f.location is not None), None)
        if loc is None:
            loc = (
                LocationRef(page=1)
                if q_doc.modality == Modality.PDF
                else LocationRef(bbox=(0.0, 0.0, 1.0, 1.0))
            )
        img = render_visual_proof(q_doc, loc, highlight_color="#DC2626")
        if img is not None:
            flag_labels = ", ".join(
                sorted({_display_flag(str(f.code)) for f in q_doc.forensic_flags})
            )
            proofs.append(
                {
                    "kind": "image",
                    "index": len(proofs) + 1,
                    "file_name": q_doc.file_name,
                    "location": flag_labels or "Quarantined",
                    "quarantined": True,
                    "data_uri": _image_to_data_uri(img),
                }
            )

    return proofs


def get_app_state(selected_dataset: str | None = None) -> dict[str, Any]:
    """Assemble live workspace corpus, raw uploaded files, Ollama availability, and presets."""
    storage_dir = settings.storage_dir
    docs = _load_ingested_docs(storage_dir)
    corpus_path, corpus_label = _infer_active_corpus(docs)
    indexed_dataset = corpus_label if corpus_label in ("synthetic_traps", "data/raw") else "synthetic_traps"

    ollama_ready, ollama_models = check_ollama_status()
    presets = _load_test_presets()
    preset_labels = {
        "TC-01": "TC-01 · Conflict",
        "TC-02": "TC-02 · Amendment",
        "TC-03": "TC-03 · Abstention",
        "TC-04": "TC-04 · Verified",
        "TC-05": "TC-05 · Injection",
    }

    total_files = len(docs)
    quarantined_count = sum(1 for d in docs if d.quarantined)
    raw_files = _list_raw_files(settings.data_raw_dir)
    traps_files = [
        p.name
        for p in sorted(settings.synthetic_traps_dir.iterdir(), key=lambda p: p.name.lower())
        if p.is_file() and p.name != ".gitkeep"
    ] if settings.synthetic_traps_dir.exists() else []

    active_selection = (
        selected_dataset
        if selected_dataset in ("synthetic_traps", "data/raw")
        else indexed_dataset
    )
    needs_reindex = bool(
        not docs
        or active_selection != indexed_dataset
        or _RAW_DIR_DIRTY
    )

    return {
        "corpus_path": corpus_path,
        "corpus_label": corpus_label,
        "indexed_dataset": indexed_dataset,
        "selected_dataset": active_selection,
        "needs_reindex": needs_reindex,
        "total_files": total_files,
        "clean_count": total_files - quarantined_count,
        "quarantined_count": quarantined_count,
        "traps_file_count": len(traps_files),
        "raw_file_count": len(raw_files),
        "raw_files": raw_files,
        "ollama_ready": ollama_ready,
        "llm_model": settings.llm_model,
        "ollama_models": ollama_models,
        "has_graph": (storage_dir / "evidence_graph.json").exists(),
        "docs": [_serialize_doc(d) for d in docs],
        "presets": [
            {
                "case_id": str(c["case_id"]),
                "label": preset_labels.get(str(c["case_id"]), str(c["case_id"])),
                "query": str(c["query"]),
            }
            for c in presets
        ],
    }


def execute_query_payload(
    query: str,
    use_llm: bool = False,
    show_full_graph: bool = False,
) -> dict[str, Any]:
    """Run answer_query and package verdict, citations, conflicts, visual proofs, and offline PyVis HTML."""
    storage_dir = settings.storage_dir
    if not (storage_dir / "evidence_graph.json").exists():
        raise FileNotFoundError("Evidence graph not built yet. Run Offline Pipeline first.")

    docs = _load_ingested_docs(storage_dir)
    docs_by_id = {d.source_id: d for d in docs}
    response = answer_query(query, storage_dir=storage_dir, use_llm=use_llm)

    conflicts_out = []
    for e in response.conflicts:
        etype = str(e.edge_type.value)
        conflicts_out.append(
            {
                "edge_type": etype,
                "display_type": _display_edge(etype),
                "detector": str(e.detector),
                "confidence": float(e.confidence),
                "reason": str(e.reason),
            }
        )

    citations_out = []
    for idx, c in enumerate(response.citations, start=1):
        citations_out.append(
            {
                "index": idx,
                "source_id": c.source_id,
                "file_name": str(c.file_name),
                "location": _format_location(c.location_ref),
                "quote": str(c.quote),
            }
        )

    quarantined_out = [_serialize_doc(s) for s in response.quarantined_sources]
    visual_proofs = _build_visual_proofs(response, docs_by_id=docs_by_id)

    graph, _, _ = load_graph_artifacts(storage_dir)
    target_ents = (
        None
        if show_full_graph
        else (response.dossier.target_entities if response.dossier else None)
    )
    graph_html = build_offline_pyvis_html(graph, highlight_entities=target_ents)

    return {
        "query": query,
        "status": str(response.status.value),
        "confidence": float(response.confidence),
        "confidence_pct": max(0, min(100, int(round(round(float(response.confidence) * 100, 4))))),
        "answer": str(response.answer),
        "citations": citations_out,
        "conflicts": conflicts_out,
        "quarantined_sources": quarantined_out,
        "counts": {
            "conflicts_citations": len(citations_out) + len(conflicts_out) + len(quarantined_out),
            "visual_proof": _count_visual_proofs(response, docs_by_id=docs_by_id),
        },
        "visual_proofs": visual_proofs,
        "graph_html": graph_html,
        "raw_json": response.model_dump(mode="json"),
    }


def save_uploaded_files(files: list[dict[str, Any]]) -> list[str]:
    """Validate and persist base64 uploaded files into settings.data_raw_dir."""
    global _RAW_DIR_DIRTY
    raw_dir = settings.data_raw_dir
    raw_dir.mkdir(parents=True, exist_ok=True)
    raw_resolved = raw_dir.resolve()
    saved: list[str] = []

    for item in files:
        if not isinstance(item, dict):
            continue
        safe_name = _sanitize_raw_filename(str(item.get("name", "")))
        b64_content = str(item.get("content_b64", ""))
        if not b64_content:
            continue
        if "," in b64_content and b64_content.startswith("data:"):
            b64_content = b64_content.split(",", 1)[1]
        target = (raw_dir / safe_name).resolve()
        if target.parent != raw_resolved:
            raise ValueError("Invalid upload path")
        target.write_bytes(base64.b64decode(b64_content))
        saved.append(safe_name)

    if saved:
        _RAW_DIR_DIRTY = True
    return saved


def delete_raw_file(raw_name: str) -> str:
    """Safely delete a single uploaded file from settings.data_raw_dir."""
    global _RAW_DIR_DIRTY
    safe_name = _sanitize_raw_filename(raw_name)
    raw_dir = settings.data_raw_dir.resolve()
    target = (raw_dir / safe_name).resolve()
    if target.parent != raw_dir:
        raise ValueError("Invalid filename")
    if not target.is_file():
        raise FileNotFoundError(f"File not found: {safe_name}")
    target.unlink()
    _RAW_DIR_DIRTY = True
    return safe_name


def run_dataset_pipeline(corpus_mode: str, use_llm: bool = False) -> dict[str, Any]:
    """Run full pipeline for 'synthetic_traps' or 'data/raw' with live stage reporting."""
    global _RAW_DIR_DIRTY
    normalized = "data/raw" if corpus_mode in ("raw", "data/raw") else "synthetic_traps"
    input_dir = settings.data_raw_dir if normalized == "data/raw" else settings.synthetic_traps_dir
    try:
        _set_progress(
            True,
            mode="pipeline",
            stage=1,
            title="Ingesting & sanitizing sources",
            detail="SHA-256 · JPEG ELA (25.0) · Hidden PDF spans · Prompt injection stripping",
        )
        docs, chunks = ingest_directory(input_dir=input_dir, storage_dir=settings.storage_dir)

        _set_progress(
            True,
            mode="pipeline",
            stage=2,
            title="Extracting atomic claims",
            detail=(
                f"Ollama {settings.llm_model} extraction · 3-tier entity resolution"
                if use_llm
                else "Deterministic claim parser · 3-tier RapidFuzz entity resolution"
            ),
        )
        claims, entity_map = extract_and_persist(storage_dir=settings.storage_dir, use_llm=use_llm)

        _set_progress(
            True,
            mode="pipeline",
            stage=3,
            title="Propagating evidence trust",
            detail="NetworkX MultiDiGraph · Temporal SUPERSEDES · 5 propagation rounds",
        )
        graph, _, scored_claims, edges = build_and_persist_graph(storage_dir=settings.storage_dir)

        summary = {
            "doc_count": len(docs),
            "chunk_count": len(chunks),
            "claim_count": len(scored_claims),
            "entity_count": len(entity_map),
            "total_nodes": graph.number_of_nodes(),
            "total_edges": graph.number_of_edges(),
            "epistemic_edge_count": len(edges),
        }
        _RAW_DIR_DIRTY = False
        state = get_app_state(selected_dataset=normalized)
        return {"summary": summary, "state": state}
    finally:
        _set_progress(False)


class CerberusHandler(BaseHTTPRequestHandler):
    """Serve landing/ files alongside local CERBERUS-X JSON API endpoints."""

    def log_message(self, format: str, *args: Any) -> None:
        return

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_json_body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        data = json.loads(raw.decode("utf-8"))
        return data if isinstance(data, dict) else {}

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        req_path = parsed.path
        qs = parse_qs(parsed.query)

        if req_path == "/api/state":
            try:
                selected = (qs.get("selected") or [None])[0]
                self._send_json(HTTPStatus.OK, get_app_state(selected_dataset=selected))
            except Exception as exc:
                self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(exc)})
            return

        if req_path == "/api/progress":
            self._send_json(HTTPStatus.OK, _get_progress())
            return

        rel = "index.html" if req_path in ("/", "") else req_path.lstrip("/")
        candidate = (LANDING_DIR / rel).resolve()
        if not str(candidate).startswith(str(LANDING_DIR.resolve())) or not candidate.is_file():
            self.send_error(HTTPStatus.NOT_FOUND, "Not Found")
            return

        ctype, _ = mimetypes.guess_type(str(candidate))
        data = candidate.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", ctype or "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        req_path = parsed.path

        try:
            body = self._read_json_body()
        except Exception as exc:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": f"Invalid JSON: {exc}"})
            return

        if req_path == "/api/query":
            query = str(body.get("query", "")).strip()
            if not query:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": "Query text is required."})
                return
            use_llm = bool(body.get("use_llm", False))
            show_full = bool(body.get("show_full_graph", False))
            try:
                payload = execute_query_payload(query, use_llm=use_llm, show_full_graph=show_full)
                self._send_json(HTTPStatus.OK, payload)
            except FileNotFoundError as exc:
                self._send_json(HTTPStatus.PRECONDITION_FAILED, {"error": str(exc)})
            except Exception as exc:
                self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(exc)})
            return

        if req_path == "/api/pipeline":
            corpus_mode = str(body.get("corpus", "synthetic_traps"))
            use_llm = bool(body.get("use_llm", False))
            try:
                result = run_dataset_pipeline(corpus_mode=corpus_mode, use_llm=use_llm)
                self._send_json(HTTPStatus.OK, result)
            except Exception as exc:
                self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(exc)})
            return

        if req_path == "/api/upload":
            files = body.get("files", [])
            selected = str(body.get("selected_dataset") or "data/raw")
            if not isinstance(files, list) or not files:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": "No files supplied."})
                return
            try:
                saved = save_uploaded_files(files)
            except ValueError as exc:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
                return
            except Exception as exc:
                self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(exc)})
                return
            state = get_app_state(selected_dataset=selected)
            self._send_json(
                HTTPStatus.OK,
                {
                    "saved": saved,
                    "raw_files": state["raw_files"],
                    "raw_file_count": state["raw_file_count"],
                    "indexed_dataset": state["indexed_dataset"],
                    "needs_reindex": state["needs_reindex"],
                    "state": state,
                },
            )
            return

        if req_path == "/api/files/delete":
            name = str(body.get("name", ""))
            selected = str(body.get("selected_dataset") or "")
            try:
                deleted = delete_raw_file(name)
            except ValueError as exc:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
                return
            except FileNotFoundError as exc:
                self._send_json(HTTPStatus.NOT_FOUND, {"error": str(exc)})
                return
            state = get_app_state(selected_dataset=selected or None)
            self._send_json(
                HTTPStatus.OK,
                {
                    "deleted": deleted,
                    "raw_files": state["raw_files"],
                    "raw_file_count": state["raw_file_count"],
                    "indexed_dataset": state["indexed_dataset"],
                    "needs_reindex": state["needs_reindex"],
                    "state": state,
                },
            )
            return

        self.send_error(HTTPStatus.NOT_FOUND, "Unknown endpoint")

    def do_DELETE(self) -> None:
        parsed = urlparse(self.path)
        req_path = parsed.path
        qs = parse_qs(parsed.query)
        prefix = "/api/files/"
        if not req_path.startswith(prefix):
            self.send_error(HTTPStatus.NOT_FOUND, "Unknown endpoint")
            return

        raw_name = req_path[len(prefix):]
        selected = (qs.get("selected") or [None])[0]
        try:
            deleted = delete_raw_file(raw_name)
        except ValueError as exc:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            return
        except FileNotFoundError as exc:
            self._send_json(HTTPStatus.NOT_FOUND, {"error": str(exc)})
            return

        state = get_app_state(selected_dataset=selected)
        self._send_json(
            HTTPStatus.OK,
            {
                "deleted": deleted,
                "raw_files": state["raw_files"],
                "raw_file_count": state["raw_file_count"],
                "indexed_dataset": state["indexed_dataset"],
                "needs_reindex": state["needs_reindex"],
                "state": state,
            },
        )


def run_server(host: str = "127.0.0.1", port: int = 8503) -> None:
    """Start the local HTTP server bound strictly to localhost."""
    httpd = ThreadingHTTPServer((host, port), CerberusHandler)
    print(f"CERBERUS-X local server listening at http://{host}:{port}")
    httpd.serve_forever()


if __name__ == "__main__":
    listen_port = int(os.environ.get("CERBERUS_LANDING_PORT", "8503"))
    run_server(port=listen_port)
