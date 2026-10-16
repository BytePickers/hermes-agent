# PLAN t_a6e89129 — Hard-Delete sendet kein Event: Tombstone-Event + Client-Prune

Task: t_a6e89129 (kind: code_change, Risikostufe L) — Folge-Karte aus Gate-B Runde 1 an t_05826e6b.
Repo: BytePickers/hermes-agent, PR-Route auf main. Quellstand: origin/main = 9deb4179 (Merge von PR #4, Stand 16.10.2026).

## Problem

Hard-Deletes (kanban_db.delete_task / delete_archived_task) löschen die task_events-Zeilen
des Tasks und hängen keinen Nachfolge-Event an. Der Dashboard-WS-Tail (plugins/kanban/dashboard/plugin_api.py
_EventTail._fetch, tailt task_events ohne Kind-Filter) liefert daher KEINEN Auslöser: Löscht ein
fremder Client (zweites Dashboard-Tab, CLI) eine Done-Karte, die über Seite 1 hinaus in extraDone
gehalten wird, bleibt sie im Dashboard-Board als Geist stehen — clientseitig unbehebbar.

## Root Cause

`_delete_task_relations()` entfernt alle task_events-Zeilen des Tasks; `delete_task()`/
`delete_archived_task()` fügen danach keinen Event hinzu. Der Client prunt extraDone nur bei
Event-Kinds in DONE_MEMBERSHIP_EVENT_KINDS (dist/index.js ~Z.195: status/completed/archived) —
ein Delete erzeugt nie eines davon.

## Evidence

- hermes_cli/kanban_db.py:4099-4125 (delete_archived_task / delete_task / _delete_task_relations) am HEAD 9deb4179 — gelesen, Befund bestätigt.
- plugins/kanban/dashboard/plugin_api.py:1755-1770 (_EventTail._fetch: SELECT ... FROM task_events, kein Kind-Filter) — gelesen.
- plugins/kanban/dashboard/dist/index.js ~Z.186-199 (DONE_MEMBERSHIP_EVENT_KINDS + Begründungskommentar) — gelesen.
- gateway/kanban_watchers_notifier.py:36 (TERMINAL_KINDS ohne "deleted" — Notifier stellt ein neues Kind NICHT in Chat zu; getestet gegen Quelltext 9deb4179).

## Proposed Solution

1. Backend: neuer Helper `_append_delete_tombstone(conn, task_id)` in hermes_cli/kanban_db.py —
   hängt `_append_event(conn, task_id, "deleted", None)` an, NACHDEM `_delete_task_relations()`
   die Alt-Events entfernt hat (sonst würde der Helper-Event mitgelöscht). Aufgerufen in
   `delete_task()` und `delete_archived_task()` innerhalb derselben write_txn, nur wenn der
   Task-DELETE tatsächlich rowcount==1 lieferte. Der Event-Row überlebt den Task (task_events ist
   append-only, kein FK).
2. Client: `"deleted"` in DONE_MEMBERSHIP_EVENT_KINDS (plugins/kanban/dashboard/dist/index.js)
   aufnehmen + Begründungskommentar aktualisieren. Der bestehende Handler-Zweig (prune
   membershipTaskIds aus extraDone + invalidateBoardFetches + doneMembershipEventsRef-Zähler)
   behandelt das Kind dann identisch zu status/completed/archived — keine neue Client-Logik.
3. Konsumenten-Abwägung (geteilte Event-Quelle, "so the surfaces cannot drift"):
   - Dashboard-WS-Tail: kein Kind-Filter → Tombstone fließt automatisch; gewollt.
   - Gateway-Notifier (TERMINAL_KINDS): "deleted" bewusst NICHT aufnehmen — ein Hard-Delete
     hat keinen Chat-Inhalt; Cursor-Advance ist unschädlich.
   - CLI/`hermes kanban show/list-events`: Tombstone erscheint als einziges Event eines
     gelöschten Tasks — gewollt (Nachvollziehbarkeit), bestehende Tests werden entsprechend
     angepasst (s. u.).
   - kanban_db_notify (Cursor-Baseline MAX(task_events.id)): unberührt.
   - kanban_transfer (Ganztisch-Replikation der task_events-Zeilen): repliziert den Tombstone
     mit — gewollt (gleiche Semantik auf Ziel-Board).
4. Disclosure: Vor Erhalt des Gate-A-Urteils wurden die beiden Backend-Einstiegspunkte
   (kanban_db.py delete_task/delete_archived_task + Helper) bereits lokal editiert (Patch-Spur
   im Worktree); der Client und die Tests wurden nach dem Mutations-Guard nicht angefasst.
   Die Implementierung wird nach APPROVE_PLAN über den PR-Branch verifiziert und committet.

## Affected Services

BytePickers/hermes-agent (kanban_db Kern + Kanban-Dashboard-Plugin). Geteilte Event-Quelle
task_events berührt: Dashboard-WS, Gateway-Notifier, CLI — zwei Oberflächen werden im
Verhalten geprüft (Dashboard-Prune, Notifier-Nicht-Zustellung), eine bleibt unverändert.

## Affected Files

- hermes_cli/kanban_db.py (Tombstone-Helper + beide Delete-Pfade)
- plugins/kanban/dashboard/dist/index.js (DONE_MEMBERSHIP_EVENT_KINDS + Kommentar)
- tests/hermes_cli/test_kanban_db.py (Delete-Tests auf Tombstone-Vertrag umgestellt + neue Tests)
- tests-js/kanban-dashboard-done-page-lifecycle.test.ts (WS-deleted-Prune-Test)
- plans/PLAN_t_a6e89129.md (dieses Dokument, im PR)

## Compatibility Risks

- Neues Event-Kind in einem append-only Strom, der von mehreren Oberflächen konsumiert wird:
  fremde Konsumenten, die task_events ungefiltert lesen, sehen ein Event ohne lebenden Task.
  Geprüft: Notifier (kind-gefiltert, "deleted" nicht enthalten), WS-Tail (gewollt), Dashboard
  (verarbeitet task_id-basiert, Task-Rohdaten werden für den Prune nicht benötigt), transfer/
  swarm (Zeilen-Replikation ohne Kind-Semantik).
- Alte Boards ohne Tombstones: keine Migration nötig — der Geist-Fall bleibt für historische
  Deletes unbehebbar (Events waren gelöscht), der Fix wirkt nur für künftige Deletes.
- doneMembershipEventsRef-Zähler: "deleted" erhöht den Zähler für die task_id; nach dem Delete
  ist die id tot, ein Kollisions-Wiederaufleben derselben id ist im Board-Kern ausgeschlossen
  (neue ids, kein id-recycle) — Neuanlage einer KARTE mit alter id unmöglich.

## Security / Data Risks

- Tombstone-Payload ist None (keine Karteninhalte im Event; Task-Zeile ist weg).
- Kein PII/Secret-Pfad; Event verlässt die Board-DB nur über die bestehenden Leseoberflächen.

## Test Plan

Backend (pytest, tests/hermes_cli/test_kanban_db.py):
- test_delete_task_appends_deleted_tombstone: nach delete_task existiert GENAU EIN Event,
  kind='deleted', task_id korrekt; Alt-Events (created/…) sind weg.
- test_delete_archived_task_appends_deleted_tombstone: analog über den Archiv-Pfad.
- bestehende test_delete_task_removes_task_and_cascades / test_delete_archived_task_removes_related_rows:
  Event-Zähl-Assertions auf den neuen Vertrag umgestellt (1 Tombstone statt 0 Events).

Client (vitest, tests-js/kanban-dashboard-done-page-lifecycle.test.ts):
- a WS deleted event prunes a card held in an extra page (no ghost): Spiegel zum bestehenden
  status-Event-Prune-Test mit kind='deleted'.
- bestehende Nicht-Membership-Testfälle bleiben unverändert grün (Regression: falscher Prune).

Batterie am exakten Head (Ersatznachweis, Quelle ohne CI): Vitest tests-js, tsc (tests-js + web,
--noEmit), ESLint tests-js, pytest hermes_cli/test_kanban_db.py + tests/plugins/test_kanban_dashboard_plugin.py.

## Rollout / Deploy

PR auf main von BytePickers/hermes-agent; Merge erst nach Gate A (APPROVE_PLAN) + Gate B (APPROVE,
am finalen Head) + lokaler Test-Batterie am exakten Head. Risikostufe L: zusätzlich Planer-Statement
und Inhaber-GO als Kartenkommentare vor dem Merge. Kein Prod-Deploy-Schritt in dieser Karte
(Quell-Arbeit); Ausrollung auf .221 folgt dem etablierten Aktualisierungs-Weg außerhalb dieses PRs.
