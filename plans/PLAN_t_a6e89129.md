# PLAN t_a6e89129 — Hard-Delete sendet kein Event: Tombstone-Event + Client-Prune (Runde 2)

Task: t_a6e89129 (kind: code_change, Risikostufe L) — Folge-Karte aus Gate-B Runde 1 an t_05826e6b.
Repo: BytePickers/hermes-agent, PR-Route auf main. Quellstand: origin/main = 9deb4179 (Merge von PR #4, Stand 16.10.2026).

## Gate-A Runde 1 — Befund-Einarbeitung (dieser Abschnitt ist neu in Runde 2)

Alle drei Befunde des Urteils vom 16.10.2026 12:46 UTC (Prüf-Faden 01a14448, REQUEST_CHANGES)
wurden am Klon 9deb4179 einzeln nachgeprüft und sind in dieser Fassung eingearbeitet:

1. **Archiv-Löschpfad-Reihenfolge (BEHOBEN, Proposed Solution Nr. 1):** Befund am Code
   bestätigt — `delete_archived_task` ließ Alt-Events (`_delete_task_relations`) VOR dem
   Task-DELETE entfernen; `write_txn` (hermes_cli/kanban_db_connect.py:1191) committet bei
   normalem Verlassen des with-Blocks, d. h. bei rowcount==0 wäre die Alt-Event-Löschung
   committed worden (Karte ohne Alt-Events und ohne Grabstein). Der Plan ändert die
   Reihenfolge in BEIDEN Löschpfaden: zuerst `DELETE FROM tasks` + rowcount-Prüfung, erst
   danach Alt-Events entfernen und Grabstein anhängen. Der Fehlschlagspfad ist jetzt
   explizit im Test Plan (Backend-Test Nr. 3).
2. **CLI-Behauptung (KORRIGIERT, Konsumenten-Abwägung Nr. 3):** Die Runde-1-Fassung
   behauptete fälschlich, der Tombstone sei via `hermes kanban show`/`list-events`
   sichtbar. Am Code widerlegt: es gibt kein `list-events`-CLI-Kommando (nur die interne
   DB-Funktion `kanban_db.list_events`), und `hermes kanban show` bricht für gelöschte
   Tasks mit „no such task" ab (hermes_cli/kanban.py:478-484). Kein CLI-Verhalten wird
   versprochen oder geändert; der echte Zugriffsweg auf Grabstein-Events ist die interne
   DB-Ebene (`kanban_db.list_events` / direktes SQL auf task_events) — dort wird der
   Tombstone auch ausschließlich getestet.
3. **TaskDrawer bei gelöschter Karte (VERHALTEN FESTGELEGT, Proposed Solution Nr. 4 +
   Test Plan):** Befund am Code bestätigt — der WS-Handler stempelt für JEDES Event einen
   per-task eventTick (dist/index.js:1311-1318), der Drawer lädt bei jedem Tick neu
   (dist/index.js:4414-4415); für eine gelöschte Karte liefert GET /tasks/:id einen Fehler
   (`_require_task`, plugin_api.py:396-408) und das Fenster zeigt einen Fehler statt sich
   zu schließen. Festgelegtes Verhalten: `deleted`-Events stempeln KEINEN eventTick und
   schließen den offenen Drawer stattdessen sofort.

## Problem

Hard-Deletes (kanban_db.delete_task / delete_archived_task) löschen die task_events-Zeilen
des Tasks und hängen keinen Nachfolge-Event an. Der Dashboard-WS-Tail (plugins/kanban/dashboard/plugin_api.py
_EventTail._fetch, tailt task_events ohne Kind-Filter) liefert daher KEINEN Auslöser: Löscht ein
fremder Client (zweites Dashboard-Tab, CLI) eine Done-Karte, die über Seite 1 hinaus in extraDone
gehalten wird, bleibt sie im Dashboard-Board als Geist stehen — clientseitig unbehebbar.

## Root Cause

`_delete_task_relations()` entfernt alle task_events-Zeilen des Tasks; `delete_task()`/
`delete_archived_task()` fügen danach keinen Event hinzu. Der Client prunt extraDone nur bei
Event-Kinds in DONE_MEMBERSHIP_EVENT_KINDS (dist/index.js Z.195: status/completed/archived) —
ein Delete erzeugt nie eines davon. Zusätzlich (Runde-1-Befund 3): der WS-Handler stempelt
jeden Event als eventTick und der TaskDrawer folgt jedem Tick mit einem GET /tasks/:id, das
für gelöschte Tasks fehlschlägt (`_require_task`).

## Evidence

- hermes_cli/kanban_db.py:4090-4131 (delete_archived_task / delete_task / _delete_task_relations) am HEAD 9deb4179 — gelesen, Befund bestätigt.
- hermes_cli/kanban_db_connect.py:1191-1231 (write_txn: COMMIT bei normalem Verlassen des with-Blocks — deshalb ist die Runde-1-Reihenfolge im Archivpfad ein echter Datenverlust-Pfad) — gelesen.
- plugins/kanban/dashboard/plugin_api.py:1755-1770 (_EventTail._fetch: SELECT ... FROM task_events, kein Kind-Filter) und plugin_api.py:396-408 (_require_task: Fehler für gelöschte task_id) — gelesen.
- plugins/kanban/dashboard/dist/index.js Z.186-199 (DONE_MEMBERSHIP_EVENT_KINDS + Begründungskommentar), Z.1269-1318 (WS-Handler: membershipTaskIds + eventTick-Stempel), Z.4375/4414-4415 (TaskDrawer: load() an props.eventTick gebunden), Z.2174 (Drawer eventTick = taskEventTick[selectedTaskId]) — gelesen.
- gateway/kanban_watchers_notifier.py:36 (TERMINAL_KINDS ohne "deleted" — Notifier stellt ein neues Kind NICHT in Chat zu) und :307 (kinds=TERMINAL_KINDS an das Abo) — gelesen.
- hermes_cli/kanban.py:478-484 (_cmd_show: `kb.get_task` → „no such task" für gelöschte Tasks; kein list-events-Kommando) — gelesen (Runde-1-Befund 2).

## Proposed Solution

1. Backend: neuer Helper `_append_delete_tombstone(conn, task_id)` in hermes_cli/kanban_db.py —
   hängt `_append_event(conn, task_id, "deleted", None)` an, NACHDEM die Alt-Events entfernt
   wurden (sonst würde der Helper-Event mitgelöscht). NEUE REIHENFOLGE in beiden Löschpfaden
   (Runde-1-Befund 1), alles innerhalb derselben write_txn:
   - `delete_task()`: zuerst `DELETE FROM tasks WHERE id = ?`; bei rowcount != 1 sofort
     `return False` (Alt-Events unberührt, kein Grabstein); bei rowcount == 1 DANACH
     `_delete_task_relations()` und `_append_delete_tombstone()`.
   - `delete_archived_task()`: Status-Check bleibt erster Schritt; danach analog — zuerst
     `DELETE FROM tasks` + rowcount-Prüfung, bei rowcount != 1 `return False` OHNE Berührung
     der Alt-Events, erst bei Erfolg `_delete_task_relations()` + Grabstein. (Damit ist der
     Runde-1-Datenverlust-Pfad strukturell ausgeschlossen: die Alt-Events werden erst
     angefasst, NACHDEM der Task-DELETE nachweislich gegriffen hat.)
   Der Event-Row überlebt den Task (task_events ist append-only, kein FK).
2. Client: `"deleted"` in DONE_MEMBERSHIP_EVENT_KINDS (plugins/kanban/dashboard/dist/index.js)
   aufnehmen + Begründungskommentar aktualisieren. Der bestehende Handler-Zweig (prune
   membershipTaskIds aus extraDone + invalidateBoardFetches + doneMembershipEventsRef-Zähler)
   behandelt das Kind dann identisch zu status/completed/archived — keine neue Prune-Logik.
3. Konsumenten-Abwägung (geteilte Event-Quelle, "so the surfaces cannot drift"):
   - Dashboard-WS-Tail: kein Kind-Filter → Tombstone fließt automatisch; gewollt.
   - Gateway-Notifier (TERMINAL_KINDS): "deleted" bewusst NICHT aufnehmen — ein Hard-Delete
     hat keinen Chat-Inhalt; Cursor-Advance ist unschädlich.
   - CLI: KEIN Sichtbarkeits- oder Verhaltensversprechen (Runde-1-Befund 2). Es gibt kein
     `list-events`-Kommando, und `hermes kanban show` bricht für gelöschte Tasks mit
     „no such task" ab — der Tombstone ist bewusst KEINE CLI-Oberfläche. Der einzige
     Zugriffsweg ist die interne DB-Ebene (`kanban_db.list_events` / SQL auf task_events);
     dort wird der Tombstone ausschließlich getestet (Backend-Tests). Keine CLI-Datei wird
     angefasst.
   - TaskDrawer (Runde-1-Befund 3): gewünschtes Verhalten — ein `deleted`-Event für die
     aktuell offene Karte (selectedTaskId) schließt den Drawer SOFORT (bestehender
     onClose-Pfad), statt ihn per eventTick zu einem GET /tasks/:id zu zwingen, das
     `_require_task` mit einem Fehler beantwortet. Der eventTick-Stempel im WS-Handler
     überspringt `deleted`-Events (Z.1311-1318: kind-Check ergänzen). Der Fehler-Fallback
     des Drawers für STALE Zustände (Drawer offen, Karte anderweitig verschwunden, ohne
     WS-Event) bleibt unverändert — der reguläre Pfad ist jetzt das saubere Schließen.
   - kanban_db_notify (Cursor-Baseline MAX(task_events.id)): unberührt.
   - kanban_transfer (Ganztisch-Replikation der task_events-Zeilen): repliziert den Tombstone
     mit — gewollt (gleiche Semantik auf Ziel-Board).
4. Disclosure: Vor Erhalt des Gate-A-Urteils wurden die beiden Backend-Einstiegspunkte
   (kanban_db.py delete_task/delete_archived_task + Helper) bereits lokal editiert (Patch-Spur
   im Worktree); der Client und die Tests wurden nach dem Mutations-Guard nicht angefasst.
   Die lokale Spur wird in der Umsetzung auf die Runde-2-Reihenfolge (Nr. 1) umgestellt und
   über den PR-Branch verifiziert und committet. Die Umsetzung bleibt hinter dem
   Planer-Statement (Stufe L) zurückgestellt.

## Affected Services

BytePickers/hermes-agent (kanban_db Kern + Kanban-Dashboard-Plugin). Geteilte Event-Quelle
task_events berührt: Dashboard-WS (Prune + Drawer-Schließen), Gateway-Notifier
(Nicht-Zustellung), CLI (bewusst keine Änderung, s. o.) — zwei Oberflächen werden im
Verhalten geprüft, eine bleibt unverändert.

## Affected Files

- hermes_cli/kanban_db.py (Tombstone-Helper + beide Delete-Pfade in der neuen Reihenfolge)
- plugins/kanban/dashboard/dist/index.js (DONE_MEMBERSHIP_EVENT_KINDS + Kommentar;
  WS-Handler: eventTick-Stempel überspringt `deleted`, offener Drawer schließt bei `deleted`)
- tests/hermes_cli/test_kanban_db.py (Delete-Tests auf Tombstone-Vertrag umgestellt + neue Tests inkl. Fehlschlagspfad)
- tests-js/kanban-dashboard-done-page-lifecycle.test.ts (WS-deleted-Prune-Test + Drawer-Schließen-Test)
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
- Drawer-Schließen ist ein rein clientseitiges UX-Verhalten; der Server-/WS-Vertrag ändert
  sich dadurch nicht (das Event kommt ohnehin an alle Tails).

## Security / Data Risks

- Tombstone-Payload ist None (keine Karteninhalte im Event; Task-Zeile ist weg).
- Kein PII/Secret-Pfad; Event verlässt die Board-DB nur über die bestehenden Leseoberflächen.
- Die neue Reihenfolge schließt ein Datenverlust-Fenster (Alt-Events werden nur noch nach
  erfolgreichem Task-DELETE entfernt) — der Fix verbessert die Lösch-Atomicsität.

## Test Plan

Backend (pytest, tests/hermes_cli/test_kanban_db.py):
- test_delete_task_appends_deleted_tombstone: nach delete_task existiert GENAU EIN Event,
  kind='deleted', task_id korrekt; Alt-Events (created/…) sind weg.
- test_delete_archived_task_appends_deleted_tombstone: analog über den Archiv-Pfad.
- (Runde-1-Befund 1) test_delete_archived_task_keeps_events_when_task_delete_fails:
  Fehlschlagspfad — der Task-DELETE greift nicht (rowcount 0, simuliert per SQLite-Trigger
  `BEFORE DELETE ON tasks ... SELECT RAISE(IGNORE)` für die Ziel-id), Funktion liefert False:
  Alt-Events sind vollständig ERHALTEN, kein Tombstone, Task-Zeile bleibt. Spiegel-Test für
  delete_task (Task fehlt bereits → False, keine Events angefasst).
- bestehende test_delete_task_removes_task_and_cascades (Z.712) /
  test_delete_archived_task_removes_related_rows (Z.688): Event-Zähl-Assertions auf den neuen
  Vertrag umgestellt (1 Tombstone statt 0 Events, kind-Check).

Client (vitest, tests-js/kanban-dashboard-done-page-lifecycle.test.ts):
- a WS deleted event prunes a card held in an extra page (no ghost): Spiegel zum bestehenden
  WS-status-Prune-Test (Z.1394) mit kind='deleted' via ws.onmessage.
- (Runde-1-Befund 3) a WS deleted event closes the open drawer instead of reloading it:
  Drawer für die Karte offen (selectedTaskId), fremdes `deleted`-Event über ws.onmessage →
  Drawer ist geschlossen, KEIN GET /tasks/:id ausgelöst (Fetch-Zähler), Event nicht als
  eventTick gestempelt.
- bestehende Nicht-Membership-Testfälle (z. B. `edited`, `reclaimed`, Z.1382/1500) bleiben
  unverändert grün (Regression: falscher Prune / falscher Tick).

Batterie am exakten Head (Ersatznachweis, Quelle ohne CI): Vitest tests-js, tsc (tests-js + web,
--noEmit), ESLint tests-js, pytest hermes_cli/test_kanban_db.py + tests/plugins/test_kanban_dashboard_plugin.py.

## Rollout / Deploy

PR auf main von BytePickers/hermes-agent; Merge erst nach Gate A (APPROVE_PLAN Runde 2) +
Planer-Statement (Stufe L, Issue e2031b29) + Gate B (APPROVE, am finalen Head) + lokaler
Test-Batterie am exakten Head. Kein Prod-Deploy-Schritt in dieser Karte (Quell-Arbeit);
Ausrollung auf .221 folgt dem etablierten Aktualisierungs-Weg außerhalb dieses PRs.
