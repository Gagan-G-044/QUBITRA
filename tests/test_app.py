"""Integration & helper tests for CERBERUS-X unified web server and Audit Console."""

from __future__ import annotations

import base64
import json
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from typing import Any

from PIL import Image
from pydantic import TypeAdapter

from core.config import settings
from core.graph_engine import load_graph_artifacts
from core.schemas import LocationRef, SourceDoc, VerdictStatus
from landing import server


def _http_json(
    url: str,
    method: str = "GET",
    payload: dict[str, Any] | None = None,
) -> tuple[int, dict[str, Any]]:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {"Content-Type": "application/json"} if payload is not None else {}
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        return err.code, json.loads(err.read().decode("utf-8"))


def test_render_visual_proof_image_pdf_and_table() -> None:
    """Verify visual proof crops render PIL images for IMAGE/PDF and None for TABLE."""
    docs = TypeAdapter(list[SourceDoc]).validate_json(
        (settings.storage_dir / "ingested_docs.json").read_text(encoding="utf-8")
    )
    by_name = {d.file_name: d for d in docs}

    img_out = server.render_visual_proof(
        by_name["receipt_scan_tampered.jpg"],
        LocationRef(bbox=(479.0, 329.0, 535.0, 343.0)),
    )
    assert isinstance(img_out, Image.Image)
    assert img_out.size == (700, 500)

    pdf_out = server.render_visual_proof(
        by_name["approval_email.pdf"],
        LocationRef(page=1, bbox=(50.0, 135.7, 407.0, 181.1)),
    )
    assert isinstance(pdf_out, Image.Image)
    assert pdf_out.width > 0 and pdf_out.height > 0

    tbl_out = server.render_visual_proof(
        by_name["ledger.csv"],
        LocationRef(row=1, column="ALL"),
    )
    assert tbl_out is None


def test_build_offline_pyvis_html_default_semantic_colors_and_no_cdn() -> None:
    """Verify PyVis generates offline HTML with default semantic colors and zero CDNs."""
    graph, _, _ = load_graph_artifacts(settings.storage_dir)
    html = server.build_offline_pyvis_html(graph, highlight_entities=["ENT_INV_402"])

    assert isinstance(html, str)
    assert len(html) > 1000
    assert "ENT_INV_402" in html
    assert "receipt_scan_tampered.jpg" in html
    assert "#2563EB" in html
    assert "#0D9488" in html
    assert "#DC2626" in html
    assert "https://cdnjs.cloudflare.com" not in html
    assert "https://cdn.jsdelivr.net" not in html
    assert "http://cdnjs.cloudflare.com" not in html
    assert "http://cdn.jsdelivr.net" not in html


def test_unified_server_http_routes_upload_delete_pipeline_and_cases(
    tmp_path: Path,
    monkeypatch,
) -> None:
    """Verify live HTTP server routes: /, /audit.html, /api/state, /api/upload, DELETE /api/files, /api/pipeline, /api/query (TC-01..TC-05)."""
    isolated_storage = tmp_path / "storage"
    isolated_raw = tmp_path / "data_raw"
    isolated_raw.mkdir(parents=True, exist_ok=True)
    isolated_storage.mkdir(parents=True, exist_ok=True)

    monkeypatch.setattr(settings, "storage_dir", isolated_storage)
    monkeypatch.setattr(settings, "data_raw_dir", isolated_raw)
    monkeypatch.setattr(server, "_RAW_DIR_DIRTY", False)

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.CerberusHandler)
    port = httpd.server_address[1]
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    base_url = f"http://127.0.0.1:{port}"

    try:
        # 1. Serve Page 1 and Page 2 HTML in same-tab structure
        with urllib.request.urlopen(f"{base_url}/", timeout=5) as resp:
            page1 = resp.read().decode("utf-8")
            assert resp.status == 200
            assert "RUN LOCAL AUDIT" in page1.upper()
            assert 'href="audit.html"' in page1

        with urllib.request.urlopen(f"{base_url}/audit.html", timeout=5) as resp:
            page2 = resp.read().decode("utf-8")
            assert resp.status == 200
            assert "AUDIT CONSOLE" in page2
            assert "evidenceGraphFrame" in page2

        # 2. Initial /api/pipeline on synthetic_traps
        st_code, pipe_res = _http_json(
            f"{base_url}/api/pipeline",
            method="POST",
            payload={"corpus": "synthetic_traps", "use_llm": False},
        )
        assert st_code == 200
        assert pipe_res["summary"]["doc_count"] == 6
        assert pipe_res["state"]["indexed_dataset"] == "synthetic_traps"
        assert pipe_res["state"]["needs_reindex"] is False

        # 3. /api/state reflects clean indexed state
        st_code, state_res = _http_json(f"{base_url}/api/state")
        assert st_code == 200
        assert state_res["indexed_dataset"] == "synthetic_traps"
        assert state_res["needs_reindex"] is False
        assert state_res["raw_files"] == []

        # 4. Upload a test note to data/raw and verify raw_files + needs_reindex
        sample_b64 = base64.b64encode(b"Audit note: shipment batch cleared.").decode("ascii")
        st_code, up_res = _http_json(
            f"{base_url}/api/upload",
            method="POST",
            payload={
                "files": [{"name": "audit_note.txt", "content_b64": sample_b64}],
                "selected_dataset": "data/raw",
            },
        )
        assert st_code == 200
        assert up_res["saved"] == ["audit_note.txt"]
        assert up_res["raw_file_count"] == 1
        assert up_res["raw_files"][0]["name"] == "audit_note.txt"
        assert up_res["raw_files"][0]["size_bytes"] > 0
        assert up_res["raw_files"][0]["ext"] == "TXT"
        assert up_res["needs_reindex"] is True
        assert (isolated_raw / "audit_note.txt").is_file()

        # 5. Path traversal rejection on delete and upload
        bad_code, _ = _http_json(f"{base_url}/api/files/..%2Fsecret.txt", method="DELETE")
        assert bad_code == 400

        # 6. Delete uploaded file and confirm cleanup
        del_code, del_res = _http_json(f"{base_url}/api/files/audit_note.txt", method="DELETE")
        assert del_code == 200
        assert del_res["deleted"] == "audit_note.txt"
        assert del_res["raw_file_count"] == 0
        assert not (isolated_raw / "audit_note.txt").exists()

        # 7. Run all 5 benchmark queries against /api/query
        cases = json.loads(settings.eval_cases_path.read_text(encoding="utf-8"))
        assert len(cases) == 5
        for case in cases:
            q_code, q_res = _http_json(
                f"{base_url}/api/query",
                method="POST",
                payload={"query": case["query"], "use_llm": False},
            )
            assert q_code == 200
            assert q_res["status"] == VerdictStatus(case["expected_status"]).value
            assert "vis-network" in q_res["graph_html"].lower() or "mynetwork" in q_res["graph_html"]
            if case["case_id"] == "TC-01":
                assert "$12,000" in q_res["answer"]
                assert len(q_res["visual_proofs"]) >= 3
    finally:
        httpd.shutdown()
        httpd.server_close()
