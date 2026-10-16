"""``hermes kanban list``: mehrzeilige Titel erzeugen keine kopflosen Folgezeilen.

Regression zu t_9d78bc43: ``_fmt_task_line`` gab ``{t.title}`` roh im f-string
aus — ein echter Zeilenumbruch im Titel (beobachtet an der Done-Karte
t_d39c345f, Umbruch nach "...block nac") renderte eine Fortsetzungszeile ohne
Karten-ID/Status-Präfix. Solche kopflosen Zeilen können als Stranded- bzw.
Geister-Beobachtung fehlinterpretiert werden.

Der Formatter flacht ``\\r\\n`` / ``\\n`` / ``\\r`` im Titel je zu einem
Leerzeichen; alles andere bleibt byte-identisch. ``--json`` und Kartendaten
(datenbankseitiger Titel) bleiben unberührt.
"""

import argparse
import json

from hermes_cli import kanban as kanban_cli
from hermes_cli import kanban_db as kb
from hermes_cli import kanban_db_connect as kbc
from hermes_cli.kanban_output import _STATUS_ICONS, _fmt_task_line

# Echte Fixture-Form: Titel von t_d39c345f (done, cubolt-agentic) mit dem
# tatsächlichen Bruchpunkt; zweiter Umbruch deckt "\\n\\n" und "\\r" ab.
MULTILINE_TITLE = (
    "DEFEKT (Hermes-Worker-Lifecycle): cubolt-agentic-Worker endet rc=0 mit "
    "protocol_violation ohne kanban_complete/block nac\n"
    "h 4x bei t_956b70fd (Runs 2180/2192/2198/2206)\n\n"
    "Dispatcher gab_up (failures 2/3) -> Task unberechtigt blocked.\rRest."
)


def _task(status="done", title=MULTILINE_TITLE, tenant=None):
    return kb.Task(
        id="t_d39c345f", title=title, body=None, assignee="cubolt-agentic",
        status=status, priority=0, created_by="test", created_at=0,
        started_at=None, completed_at=None, workspace_kind="scratch",
        workspace_path=None, claim_lock=None, claim_expires=None, tenant=tenant,
    )


# ---------------------------------------------------------------------------
# (i) Formatter-Ebene
# ---------------------------------------------------------------------------

def test_multiline_title_renders_without_line_breaks():
    line = _fmt_task_line(_task())
    assert "\n" not in line
    assert "\r" not in line
    assert line.splitlines() == [line]


def test_multiline_title_breaks_become_single_spaces():
    line = _fmt_task_line(_task())
    # \\r\\n / \\n / \\r → je EIN Leerzeichen; Bruchpunkt der echten Karte:
    assert "block nac h 4x bei t_956b70fd" in line
    # "\\n\\n" → zwei Leerzeichen (nicht kollabieren), "\\r" → ein Leerzeichen:
    assert "2206)  Dispatcher" in line
    assert "blocked. Rest." in line
    # führender/abschließender Titel-Text bleibt byte-erhalten:
    assert line.endswith("protocol_violation ohne kanban_complete/block nac h 4x"
                         " bei t_956b70fd (Runs 2180/2192/2198/2206)  Dispatcher"
                         " gab_up (failures 2/3) -> Task unberechtigt blocked."
                         " Rest.")


def test_single_line_title_is_byte_identical():
    title = "ganz normaler Titel ohne Umbruch"
    line = _fmt_task_line(_task(status="running", title=title))
    assert line == f"● t_d39c345f  running   cubolt-agentic        {title}"


def test_tenant_suffix_still_renders():
    line = _fmt_task_line(_task(title="eins\nzwei", tenant="acme"))
    assert "[acme]" in line
    assert "eins zwei" in line
    assert line.splitlines() == [line]


def test_all_status_icons_render_single_line():
    for status in _STATUS_ICONS:
        line = _fmt_task_line(_task(status=status, title="a\nb"))
        assert line.startswith(f"{_STATUS_ICONS[status]} t_d39c345f")
        assert line.splitlines() == [line]


# ---------------------------------------------------------------------------
# (ii) CLI-Ebene: `_cmd_list` gibt je Karte genau eine Präfix-Zeile aus
# ---------------------------------------------------------------------------

def _list_args(**overrides):
    defaults = dict(
        assignee=None, mine=False, status=None, tenant=None, session=None,
        archived=False, sort=None, workflow_template_id=None,
        current_step_key=None, json=False,
    )
    defaults.update(overrides)
    return argparse.Namespace(**defaults)


def _seed_board(monkeypatch, tmp_path, titles):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.delenv("HERMES_KANBAN_TASK", raising=False)
    monkeypatch.delenv("HERMES_KANBAN_DB", raising=False)
    monkeypatch.delenv("HERMES_KANBAN_HOME", raising=False)
    kb.init_db()
    ids = []
    with kbc.connect_closing() as conn:
        for title in titles:
            ids.append(kb.create_task(conn, title=title, assignee="cubolt-agentic"))
        kb.complete_task(conn, ids[0], result="ok")
    return ids


def test_cmd_list_emits_one_prefixed_line_per_card(tmp_path, monkeypatch, capsys):
    _seed_board(monkeypatch, tmp_path, [MULTILINE_TITLE, "einfacher Titel"])
    rc = kanban_cli._cmd_list(_list_args())
    assert rc == 0
    out = capsys.readouterr().out
    lines = out.splitlines()
    assert len(lines) == 2, out
    for line in lines:
        # jede Zeile trägt Status-Icon + Karten-ID-Präfix — keine kopflose Zeile
        assert line[0] in _STATUS_ICONS.values(), line
        assert " t_" in line, line
    joined = " ".join(lines)
    assert "block nac h 4x bei t_956b70fd" in joined
    assert "einfacher Titel" in joined


def test_cmd_list_multiline_task_has_no_headless_continuation(tmp_path, monkeypatch, capsys):
    _seed_board(monkeypatch, tmp_path, [MULTILINE_TITLE])
    rc = kanban_cli._cmd_list(_list_args())
    assert rc == 0
    out = capsys.readouterr().out
    lines = out.splitlines()
    assert len(lines) == 1, out
    assert lines[0].startswith("✓ t_")
    assert "\n" not in out.removesuffix("\n")
    assert "\r" not in out


# ---------------------------------------------------------------------------
# (iii) JSON-Ebene: Titel bleibt byte-gleich (echter Umbruch erhalten)
# ---------------------------------------------------------------------------

def test_cmd_list_json_keeps_raw_title(tmp_path, monkeypatch, capsys):
    _seed_board(monkeypatch, tmp_path, [MULTILINE_TITLE])
    rc = kanban_cli._cmd_list(_list_args(json=True))
    assert rc == 0
    payload = json.loads(capsys.readouterr().out)
    assert isinstance(payload, list) and len(payload) == 1
    assert payload[0]["title"] == MULTILINE_TITLE
    assert "\n" in payload[0]["title"]
