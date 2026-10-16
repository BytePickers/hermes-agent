# PLAN t_a50572ee — Port: Claim-Release-Survivor-Guard (Verteiler-Stopp-Schutz) auf die Live-Basis .221

Port-Auftrag (aus t_ce5a4d17, Inhaber-GO 11.10., Register /home/cubolt/stand/projekte.md Z.167):
Die am Fork zusammengeführte Semantik von PR byte-saas/cubolt-hermes-agent#185 (Merge
6cb1e71dac auf dev) wird auf die LIVE-Linie (.221-Prod-Basis) neu geschnitten. Eine
direkte Übernahme ist technisch unmöglich (Bauart-Kluft, belegt im Lage-Kommentar auf
t_ce5a4d17). Referenz ist die SEMANTIK von PR #185, nicht der Diff wörtlich — die
Datei-/Funktionsstruktur der Live-Bauart ist maßgeblich.

- Repo: byte-saas/cubolt-hermes-agent — Ziel-Basis EXAKT der Live-Prod-HEAD `fef78a4803`
  (Branch `port/reclaimguard-t_ce5a4d17`). fork/dev ist KEIN Stützpunkt (divergiert).
- Art: code_change (Kern: `hermes_cli/kanban_db_dispatch.py` + `hermes_cli/kanban_db.py`
  + `plugins/kanban/dashboard/plugin_api.py` + Tests).
- Sicherungs-/Review-Kanal: Branch-Push auf den Fork; Prüfung am exakten Kopf. KEIN PR
  nach dev (falsche Bauart), KEIN Integrations-PR auf Bereitstellungs-Linien.
- Ausrollung: ausschließlich t_ce5a4d17 (infra) — dieser Port berührt den Host NICHT.

## 1. Belesen-Ausweis (Quellenstand 11.10.)

| Quelle | Fundstelle | Stand |
|---|---|---|
| Träger-Plan | `docs/plans/PLAN_t_979fe21a_reclaim_terminates_run.md` (Merge 6cb1e71dac) | vollständig gelesen; Gate A APPROVE_PLAN am Plan-Kopf 553ea2c18, Gate B Runde 3 APPROVE am Kopf 30d417cfec |
| Planer-Statement zur Fix-Klasse | Träger-Karte t_979fe21a (Kommentar 28356, 11.10. 08:34): AMPEL GRÜN mit drei Bindungen — non-Linux `_group_alive`→None; Invalidierungs-Re-Schutz als CAS mit benanntem Residuen-Fenster; Port erst nach Merge | gelesen, eingearbeitet |
| PR #185 Diff | 1197 Zeilen, 6 Dateien (Köpfe 553ea2c18 → 6876c1db0 → 1684e0061f → 30d417cfec) | vollständig gelesen |
| Live-Prod-HEAD fef78a4803 | `hermes_cli/kanban_db.py` (4.587 Z.) + `hermes_cli/kanban_db_dispatch.py` (3.338 Z.) + `plugins/kanban/dashboard/plugin_api.py` | am Original gelesen (Zeilenstand unten) |
| Fork-Primitive am Merge-Knoten | `_signal_worker_group` (13060), `_group_alive` (13088), `_terminate_process_tree` (13147), `_terminate_reclaimed_worker` (13222), `_worker_survived_termination` (13260), `_reprotect_demoted_claim` (13333), `_drain_invalidation_terminations` (13388), `reclaim_stale_ready_claims` (13925) | aus `git show 6cb1e71dac:hermes_cli/kanban_db.py` gelesen |
| Wissens-Abfrage | Hindsight-Recall (ergiebig zu Gate-B-Runden, Bauart-Kluft, Live-Reclaim-Mechanik); knowledge_recall: Leer-Befund (STATUS 200, []) | 11.10. |
| Lage-Kommentar | t_ce5a4d17 Kommentar (infra, Lauf 12229): Fix-Symbole am Prod-HEAD 0-fach; fork/deploy-Linie divergiert 92/9052 | gelesen |

## 2. Bauart der Live-Linie (Unterschied zum Fork, maßgeblich für den Schnitt)

1. EIN Terminator: `_terminate_reclaimed_worker` lebt in `kanban_db_dispatch.py`;
   `kanban_db.py` importiert ihn am Dateiende (`from hermes_cli.kanban_db_dispatch import ...`).
   release_stale_claims (TTL-Sweep, kanban_db.py 2540) ist bereits bewacht
   (`_worker_survived_termination` + `_defer_reclaim_for_live_worker`); heartbeat-Sweep
   (detect_stale_running, dispatch 824) ebenso. Die beiden Stellen sind UNVERÄNDERT zu lassen.
2. Kein Gruppen-Vektor: `_group_alive`/`_terminate_process_tree`/`killpg`/`signal_mode`/
   `group_verified_dead` existieren 0-fach. Der Spawn (`_default_spawn`) setzt
   `start_new_session=True` (dispatch 3259) — der Worker ist eigener Sitzungs- UND
   Prozessgruppen-Leiter (pgid == pid); killpg erreicht in-flight Werkzeug-Kinder.
3. Fingerprint-Logik der Live-Linie (im Fork NICHT vorhanden, MUSS erhalten bleiben):
   `worker_started_at`-Fingerprint, `_pid_recycled`, `UNVERIFIED_WORKER_FINGERPRINT` mit
   `signal_refused` (nie per nackter PID signalisieren).
4. `enforce_max_runtime` (dispatch 678) tötet inline (SIGTERM → Poll → SIGKILL) und gibt
   den Anspruch bedingungslos frei — ungeschützt.
5. `reclaim_task` (kanban_db.py 2640) gibt ohne Überlebens-Schutz frei (running/ready/blocked).
6. `invalidate_descendants_for_parent_reopen` (kanban_db.py 3806) demotioniert atomar
   (Anspruchsfelder in derselben Transaktion geleert) und terminiert post-commit
   (3-Tupel mit started_at); Komponierende Aufrufer sleifen selbst — ohne Task-ID, ohne Schutz.
7. Dashboard-Direktpfad `_set_status_direct` (plugin_api.py 730) demotioniert mit geleertem
   Anspruch und terminiert post-commit; Zurück-Öffnen eines erledigten Vorfahren mischt beide
   Beendigungsquellen in EINE Liste.
8. Kein Nicht-laufend-Sweep: `reclaim_stale_ready_claims` existiert am Live-HEAD nicht
   (nur in alten Worktrees). Der lebensblinde `release_orphaned_task_claims` (dispatch 1053)
   räumt abgelaufene Ansprüche auf Nicht-running-Zeilen OHNE Liveness-Prüfung — er läuft in
   derselben Tick-Phase NACH den Terminierungs-Sweeps.
9. `archive_task` (kanban_db.py 3958) löscht den Anspruch in der Archiv-Transaktion und
   terminiert post-commit — bleibt UNVERÄNDERT: `archived` ist terminal und nicht
   spawnbar, kein Doppelschreiber-Fenster (der Referenz-Antrag #185 fasst die Stelle
   ebenfalls nicht an).

## 3. Fix-Design (Klasse / Belegfall / Wirksamkeits-Kennzahl)

**Klasse:** Freigabe eines Board-Arbeitsanspruchs, während der geschützte Arbeitsprozess
(Worker ODER seine Prozessgruppe) nachweislich noch lebt → Doppelschreiber auf geteilten
Zuständen. Schutz an der Engstelle (Anspruchs-Freigabe in jedem Terminierungspfad),
fail-closed (Halten statt Freigeben), pro Klasse (alle ungeschützten Stellen).

**Belegfall:** Run 4521 / t_9b17e3cc (13.09.2026, Reclaim mit `terminated:true` bei
weiterlaufender Arbeit); im Code: `reclaim_task`/`enforce_max_runtime`-Freigabe bei
überlebendem Worker (heute reproduzierbar).

**Wirksamkeits-Kennzahl:** Liveness-Probe-Tests mit echten Prozessen (Leiter + Werkzeug-Kind,
`start_new_session=True`): nach belegtem Tod lebt kein Gruppen-Mitglied mehr UND die Gruppe
ist verifiziert tot (`group_verified_dead=True`); im Survivor-Fall bleibt der Anspruch
gesetzt und ein sichtbares `reclaim_deferred`-Event mit Zähler-Feld wird geschrieben.

### Änderungen (minimal-invasiv, auf die Live-Bauart zugeschnitten)

1. **Gruppen-Primitive in `kanban_db_dispatch.py`** (neu auf dieser Linie):
   `_signal_worker_group` (killpg, Fallback pid; `signal_fn`-Testhaken → pid-Modus),
   `_group_alive` (killpg(0)-Probe + /proc-Enumeration mit Zombie-Filter; non-Linux → None;
   PermissionError → True), `_terminate_process_tree` (SIGTERM-Gruppe → Grace 10×0,5 s →
   SIGKILL → Gruppen-Nachiveau → `signal_mode`/`group_verified_dead`).
2. **`_terminate_reclaimed_worker` (dispatch)**: Signalweg über `_terminate_process_tree`;
   Fingerprint/UNVERIFIED/Recycling-Logik unverändert erhalten. Neue Felder im Report:
   `signal_mode`, `group_verified_dead`.
3. **`_worker_survived_termination` (dispatch, EIN Punkt für alle Pfade)**: `terminated`
   falsch → Überleben; `terminated` wahr + `group_verified_dead is False` → Überleben;
   `None` (unwissbar) → Leader-only-Vertrag wie bisher; `signal_refused` bleibt Überleben.
4. **(A) `reclaim_task` (kanban_db.py)**: Survivor-Guard nach der Terminierung; Überleben +
   running → `_defer_reclaim_for_live_worker(..., reason="manual_reclaim_worker_alive")`,
   Rückgabe False; Nicht-running mit Anspruch → Rückgabe False ohne Freigabe (der bewachte
   Nicht-laufend-Sweep übernimmt). Aufrufer (`reassign_task reclaim_first=True`, Dashboard)
   erhalten sauber False.
5. **(B1) `enforce_max_runtime` (dispatch)**: Terminierung über `_terminate_reclaimed_worker`
   (+ started_at-Fingerprint); bei Überleben Halten (Grund `max_runtime_worker_alive`, kein
   `timed_out`-Abschluss, kein Failure-Counter-Bump bis belegtem Tod); UNVERIFIED-Sprung
   (714 ff.) bleibt unverändert.
6. **(B) Invalidierung (kanban_db.py)**: `termination_task_ids` parallel zu `terminations`
   (nur running-Nachfolger); Standalone-Abfluss über den gemeinsamen Helfer
   `_drain_invalidation_terminations` (Terminierung mit started_at; bei Überleben
   CAS-Re-Schutz). Komponierende Aufrufer MÜSSEN über den Helfer sleifen (Docstring).
7. **CAS-Re-Schutz `_reprotect_demoted_claim` (kanban_db.py, neu)**: bewehrt
   `claim_lock`/`worker_pid`/`claim_expires` (now + `RECLAIM_DEFER_GRACE_SECONDS`) — nur auf
   `todo`/`ready`/`review` UND nur wenn der Anspruch leer ist (CAS; fremder Anspruch wird nie
   überschrieben); schreibt sichtbares `reclaim_deferred`-Event. Residuum (benannt): das
   Fenster zwischen Demotions-Commit und Re-Schutz ist so lang wie der misslungene
   Terminierungsversuch selbst (Sekunden).
8. **(B2) Dashboard-Direktpfad (plugin_api.py `_set_status_direct`)**: zwei GETRENNTE
   Listen-Paare mit eigenen Grund-Schildern — Direkt-Demotion →
   `direct_status_demotion_survived` (mit Task-ID), Zurück-Öffnen-Invalidierung →
   `invalidation_descendant_survived`; beides über den gemeinsamen Abfluss.
9. **Nicht-laufend-Sweep `reclaim_stale_ready_claims` (dispatch, neu auf dieser Linie)** —
   Abhängigkeit des Re-Schutzes: findet abgelaufene Ansprüche auf spawnbaren Nicht-running-
   Zeilen, terminiert bewacht (Überleben → Anspruchsfenster VERLÄNGERT statt Freigabe, damit
   der lebensblinde `release_orphaned_task_claims` im selben Tick den Hold nicht wegwischt;
   belegter Tod → Anspruch geleert, Lauf geschlossen, `reclaimed`-Event mit Grund
   `stale_claim_on_non_running_task`). Verdrahtet in `_run_reclaim_phase` NACH
   `enforce_max_runtime` und VOR `reap_orphaned_runs`/`release_orphaned_task_claims`;
   `DispatchResult.stale_ready_reclaimed` neu.
10. **Spawn-Tore unverändert** (`claim_lock IS NULL`-Pickers); TTL-Sweep + Herzschlag-Sweep
    unverändert; `archive_task` unverändert (Begründung §2.9).

### Explizit aus dem Umfang

- PID-Recycling-Identität (Spawn-Fingerprint): andere Fehlerklasse, bleibt wie heute —
  wird als Randbefund gemeldet, nicht hier verschlossen.
- Ausrollung/Neustart: t_ce5a4d17 (infra), nicht dieser Port.

## 4. Testplan (`tests/hermes_cli/test_kanban_db.py` + Bestands-Suiten)

1. `test_worker_survived_termination_group_alive_counts_as_survived` — Unit über die
   Guard-Dict-Formen (group False → True; None → False; True → False; nicht-host-local → False).
2. `test_reclaim_task_defers_when_worker_survives` — Survivor-Dict gemockt → False, Karte
   bleibt running, Anspruch bleibt, `reclaim_deferred` (Grund `manual_reclaim_worker_alive`);
   Todes-Dict → True, Anspruch frei.
3. `test_reclaim_task_defers_then_releases_real_processes` (POSIX, echte Prozesse) —
   Leiter + Werkzeug-Kind; Noop-Signal → Survivor → Defer; echte Gruppen-Terminierung →
   kein Gruppen-Mitglied lebt, Freigabe.
4. `test_enforce_max_runtime_defers_when_worker_survives` + Real-Prozess-Variante —
   Überleben → Claim bleibt, Grund `max_runtime_worker_alive`, kein `timed_out`; verifizierter
   Tod → Freigabe wie bisher.
5. `test_invalidation_reprotects_claim_when_descendant_survives` + Gegenfall (verifizierter
   Tod → Anspruch frei, kein Event); `test_reprotect_demoted_claim_cas_never_overwrites_
   foreign_claim` (todo/ready/review; fremder Anspruch; blocked → False).
6. `test_dashboard_direct_status_reprotects_surviving_worker` +
   `test_dashboard_reopen_via_direct_status_labels_descendant_survivor` (getrennte Grund-
   Schilder, Task-ID im Direkteintrag).
7. Neu auf dieser Linie: `reclaim_stale_ready_claims` — abgelaufener Anspruch auf
   Nicht-running-Zeile mit totem Worker → Freigabe + Event; lebender Survivor → Fenster
   verlängert, Anspruch bleibt, kein `reclaimed`-Event; frischer Anspruch (nicht abgelaufen)
   → unberührt.
8. Bestands-Tests auf den neuen Vertrag gebracht (Simulationen stubben zusätzlich die
   Gruppen-Sonde — die pytest-eigene Prozessgruppe ist real lebend, der Guard hält sonst
   korrekt): `test_max_runtime_terminates_overrun_worker`, `test_no_progress_fallback...`
   (frontier resolver), `test_kanban_block_classify`, UNVERIFIED-Operator-Reclaim
   (pid_fingerprint) — der UNVERIFIED-Lebend-Fall bleibt jetzt ebenfalls gehalten
   (signal_refused = möglicherweise lebender Worker; Vertrag „nie neben möglich-lebendem
   Prozess freigeben" schlägt die alte Freigabe-Ausnahme).
9. Ziel-Suiten: `tests/hermes_cli/test_kanban_db.py` + Dispatch-nahe Suiten
   (pid_fingerprint, parent_reopen_invalidation, review_lifecycle_complete, ghost_reap,
   terminal_worker_reaper, core_functionality, block_classify, reclaim_claim_lock_guard).
   ruff auf geänderten Dateien. KEINE Full-Suite als Beweis (~390 Baseline-Fails am
   unveränderten Stand).

## 5. Lieferweg

1. Plan-Dokument (dieses) auf `port/reclaimguard-t_ce5a4d17`, Push auf den Fork, Plan-PR
   (Sicherungs-/Review-Kanal; KEIN Integrations-Ziel), Gate A über den sanctioned
   OPEN-Pfad (`host-verify-open-plan --persist`) → Mutations-Freigabe.
2. Planer-erst-Pflicht: Anfrage-Karte t_410efa4c an @planer (belesen — Ausweis §1);
   Statement wird auf der Port-Karte gesichert.
3. Umsetzung auf demselben Zweig, Ziel-Suiten lokal grün, ruff, Push, CI am Kopf.
4. Gate B: unabhängige Prüf-Bahn (Prüfkarte, Verteilung codex-review) am EXAKTEN Port-Kopf
   → Urteil + Begründung am Kartenort.
5. Abschluss der Port-Karte mit Kopf-SHA + Test-Nachweisen + Gate-A/B-Belegen; t_ce5a4d17
   fährt die Ausrollung (Backup-Ref, ff-only auf Prod-main, Ruhe-Fenster-Neustart,
   Lebend-Proben) — außerhalb dieses Ports.

## 6. Risiken / Grenzen

- Non-Linux: `_group_alive` → None (unwissbar) — Leader-only-Vertrag dort unverändert.
- D-State-Kind auf Linux: begrenztes Defer (Anspruch +120 s je Tick, Selbstheilung, solange
  SIGKILL zustellbar); Sichtbarkeit über `reclaim_deferred`-Events vor Stille.
- UNVERIFIED-Lebend-Fall wird vom Operator-Reclaim jetzt ebenfalls gehalten (Vertrag
  schlägt alte Ausnahme) — ehrlich benannt, Test angepasst.
- Fenster Demotion→Re-Schutz = Dauer des misslungenen Terminierungsversuchs (Sekunden) —
  benanntes, akzeptiertes Residuum (wie im Träger-Plan, Gate B Runde 1 B3).
- Fingerprint-Lücke (PID-Recycling) bleibt — gemeldet, nicht hier verschlossen.
