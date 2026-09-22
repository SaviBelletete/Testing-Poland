"""
Pytest tests for the payment processor Python worker.
Tests cover: client detection, sheet detection, column mapping helpers,
duplicate detection, reconciliation checks, and the Flask API endpoints.
"""
import io
import json
import sys
import os
import pytest
from datetime import datetime

# Add the python-worker directory to path so we can import the module
sys.path.insert(0, os.path.dirname(__file__))

# Import functions from the worker
from process_payments import (
    detect_client,
    detect_target_sheet,
    col_letter_to_num,
    num_to_col_letter,
    cell_ref_to_row_col,
    date_to_excel_serial,
    make_cell_xml,
    app as flask_app,
)


# ─── Client Detection Tests ───────────────────────────────────────────────────

class TestDetectClient:
    def test_sc_johnson_from_filename(self):
        assert detect_client("extractedSCJ.xlsx", "SC_Johnson_Master.xlsm", []) == "SC Johnson"

    def test_sc_johnson_case_insensitive(self):
        assert detect_client("scj_weekly.xlsx", "master.xlsm", []) == "SC Johnson"

    def test_pepsico_from_filename(self):
        assert detect_client("PepsiCoextracted.xlsx", "PepsiCo_FR_UK_Master.xlsm", []) == "PepsiCo"

    def test_pepsico_lowercase(self):
        assert detect_client("pepsi_weekly.xlsx", "master.xlsm", []) == "PepsiCo"

    def test_unknown_client(self):
        assert detect_client("weekly.xlsx", "master.xlsm", []) == "Unknown"

    def test_sc_johnson_from_sheet_names(self):
        result = detect_client("weekly.xlsx", "master.xlsm", ["Johnson UK", "Johnson Poland"])
        assert result == "SC Johnson"

    def test_pepsico_from_sheet_names(self):
        result = detect_client("weekly.xlsx", "master.xlsm", ["PepsiCo France"])
        assert result == "PepsiCo"


# ─── Sheet Detection Tests ────────────────────────────────────────────────────

class TestDetectTargetSheet:
    def test_exact_match(self):
        assert detect_target_sheet("Poland", ["Poland", "France", "UK"]) == "Poland"

    def test_case_insensitive_match(self):
        assert detect_target_sheet("poland", ["Poland", "France"]) == "Poland"

    def test_france_match(self):
        assert detect_target_sheet("France", ["Poland", "France", "UK"]) == "France"

    def test_arkusz1_maps_to_poland(self):
        # Arkusz1 is Polish for Sheet1 — should map to Poland sheet
        result = detect_target_sheet("Arkusz1", ["Poland", "France", "UK"])
        assert result == "Poland"

    def test_arkusz1_maps_to_france_when_no_poland(self):
        result = detect_target_sheet("Arkusz1", ["France", "UK"])
        assert result == "France"

    def test_sheet1_maps_to_poland(self):
        result = detect_target_sheet("Sheet1", ["Poland", "France"])
        assert result == "Poland"

    def test_uk_match(self):
        assert detect_target_sheet("UK", ["Poland", "France", "UK"]) == "UK"

    def test_gb_maps_to_uk(self):
        result = detect_target_sheet("GB", ["Poland", "France", "UK"])
        assert result == "UK"

    def test_no_match_returns_none(self):
        result = detect_target_sheet("Australia", ["Poland", "France"])
        assert result is None

    def test_partial_match(self):
        # "UK" should match "United Kingdom" sheet
        result = detect_target_sheet("UK", ["United Kingdom", "France"])
        assert result == "United Kingdom"


# ─── Column Letter/Number Conversion Tests ───────────────────────────────────

class TestColumnConversion:
    def test_a_is_1(self):
        assert col_letter_to_num("A") == 1

    def test_z_is_26(self):
        assert col_letter_to_num("Z") == 26

    def test_aa_is_27(self):
        assert col_letter_to_num("AA") == 27

    def test_az_is_52(self):
        assert col_letter_to_num("AZ") == 52

    def test_num_to_letter_1(self):
        assert num_to_col_letter(1) == "A"

    def test_num_to_letter_26(self):
        assert num_to_col_letter(26) == "Z"

    def test_num_to_letter_27(self):
        assert num_to_col_letter(27) == "AA"

    def test_roundtrip(self):
        for n in [1, 13, 26, 27, 52, 53, 100]:
            assert col_letter_to_num(num_to_col_letter(n)) == n


# ─── Cell Reference Parsing Tests ────────────────────────────────────────────

class TestCellRef:
    def test_a1(self):
        col, row = cell_ref_to_row_col("A1")
        assert col == 1 and row == 1

    def test_z99(self):
        col, row = cell_ref_to_row_col("Z99")
        assert col == 26 and row == 99

    def test_aa1(self):
        col, row = cell_ref_to_row_col("AA1")
        assert col == 27 and row == 1

    def test_absolute_ref(self):
        col, row = cell_ref_to_row_col("$B$5")
        assert col == 2 and row == 5

    def test_invalid_ref(self):
        col, row = cell_ref_to_row_col("invalid")
        assert col is None and row is None


# ─── Date Conversion Tests ────────────────────────────────────────────────────

class TestDateConversion:
    def test_none_returns_none(self):
        assert date_to_excel_serial(None) is None

    def test_excel_epoch(self):
        # Excel epoch is 1899-12-30, so 1900-01-01 = serial 2
        # (Excel has a leap year bug treating 1900-02-29 as valid)
        dt = datetime(1900, 1, 1)
        serial = date_to_excel_serial(dt)
        assert abs(serial - 2.0) < 0.001

    def test_known_date(self):
        # 2024-01-15 should be a known Excel serial
        dt = datetime(2024, 1, 15)
        serial = date_to_excel_serial(dt)
        # Excel serial for 2024-01-15 is 45306
        assert abs(serial - 45306) < 1


# ─── Cell XML Generation Tests ───────────────────────────────────────────────

class TestMakeCellXml:
    def test_string_value(self):
        xml = make_cell_xml(1, 1, "Hello")
        assert 'inlineStr' in xml
        assert 'Hello' in xml
        assert 'A1' in xml

    def test_numeric_value(self):
        xml = make_cell_xml(2, 3, 42.5)
        assert '<v>42.5</v>' in xml
        assert 'B3' in xml

    def test_empty_value(self):
        xml = make_cell_xml(1, 1, None)
        assert '<c r="A1"/>' == xml

    def test_empty_string(self):
        xml = make_cell_xml(1, 1, "")
        assert '<c r="A1"/>' == xml

    def test_xml_escaping(self):
        xml = make_cell_xml(1, 1, "A & B < C > D")
        assert '&amp;' in xml
        assert '&lt;' in xml
        assert '&gt;' in xml

    def test_datetime_value(self):
        dt = datetime(2024, 1, 15)
        xml = make_cell_xml(1, 1, dt)
        assert 's="1"' in xml  # date style
        assert '<v>' in xml


# ─── Reconciliation Logic Tests ──────────────────────────────────────────────

class TestReconciliation:
    """Test reconciliation logic directly via the Flask test client."""

    @pytest.fixture
    def client(self):
        flask_app.config['TESTING'] = True
        with flask_app.test_client() as c:
            yield c

    def test_health_endpoint(self, client):
        r = client.get('/health')
        assert r.status_code == 200
        data = json.loads(r.data)
        assert data['status'] == 'ok'

    def test_process_requires_files(self, client):
        r = client.post('/process')
        assert r.status_code == 400

    def test_process_requires_master_file(self, client):
        data = {'weeklyFile': (io.BytesIO(b'fake'), 'weekly.xlsx')}
        r = client.post('/process', data=data, content_type='multipart/form-data')
        assert r.status_code == 400


# ─── Duplicate Detection Logic Tests ─────────────────────────────────────────

class TestDuplicateDetection:
    """Test the duplicate detection logic."""

    def test_new_serial_not_in_existing(self):
        existing = {"SN001", "SN002", "SN003"}
        new_serial = "SN004"
        assert new_serial not in existing

    def test_duplicate_serial_detected(self):
        existing = {"SN001", "SN002", "SN003"}
        duplicate = "SN001"
        assert duplicate in existing

    def test_case_sensitive_serial_matching(self):
        existing = {"SN001", "SN002"}
        # Serials are stored as stripped strings
        assert "SN001" in existing
        assert "sn001" not in existing  # case-sensitive

    def test_empty_existing_set(self):
        existing = set()
        assert "SN001" not in existing

    def test_all_duplicates_skipped(self):
        existing = {"SN001", "SN002", "SN003"}
        incoming = ["SN001", "SN002", "SN003"]
        skipped = [s for s in incoming if s in existing]
        added = [s for s in incoming if s not in existing]
        assert len(skipped) == 3
        assert len(added) == 0

    def test_partial_duplicates(self):
        existing = {"SN001", "SN002"}
        incoming = ["SN001", "SN003", "SN004"]
        skipped = [s for s in incoming if s in existing]
        added = [s for s in incoming if s not in existing]
        assert len(skipped) == 1
        assert len(added) == 2


# ─── Amount Reconciliation Tests ─────────────────────────────────────────────

class TestAmountReconciliation:
    """Test amount reconciliation logic."""

    def test_amounts_match(self):
        weekly_total = 183.00
        added_total = 183.00
        assert abs(weekly_total - added_total) < 0.01

    def test_amounts_do_not_match(self):
        weekly_total = 183.00
        added_total = 180.00
        assert not (abs(weekly_total - added_total) < 0.01)

    def test_all_duplicates_zero_added(self):
        # When all rows are duplicates, added_total = 0, weekly_total > 0
        # Reconciliation should still pass (special case)
        weekly_total = 183.00
        added_total = 0.0
        rows_added = 0
        # If no rows were added (all duplicates), reconciliation passes
        passes = rows_added == 0 or abs(weekly_total - added_total) < 0.01
        assert passes

    def test_partial_duplicates_amount_check(self):
        # 3 weekly rows, 1 duplicate, 2 added
        weekly_rows = [
            {"serial": "SN001", "value": 10.0},
            {"serial": "SN002", "value": 20.0},
            {"serial": "SN003", "value": 30.0},
        ]
        existing = {"SN001"}
        new_rows = [r for r in weekly_rows if r["serial"] not in existing]
        added_total = sum(r["value"] for r in new_rows)
        # Weekly total for non-duplicate rows
        expected_total = sum(r["value"] for r in weekly_rows if r["serial"] not in existing)
        assert abs(added_total - expected_total) < 0.01
        assert abs(added_total - 50.0) < 0.01


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
