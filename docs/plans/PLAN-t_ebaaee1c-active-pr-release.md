# PLAN-t_ebaaee1c: active_pr-Respawn-Guard — Re-queue-Freigabe + zustandsbasierte MERGED-Freigabe

Autor: infra (Lauf 10952) · 08.10.2026 · Planer-Freigabe: AMPEL GRÜN mit Auflagen B1–B5 (Statement-Kommentar 24239 auf t_ebaaee1c, gesichert 08.10. 08:5x CEST).

## §0 Basis- und Anker-Regel

- PR-Basis (deklariert): `byte-saas/cubolt-hermes-agent` Zweig `deploy/upstream-main` @ **4ec764c82e30b032d866b8513c47815a651d4d41** (Tip nach Merge PR #173, Geister-Ernte t_56037ffe). Arbeitszweig: `fix/t_ebaaee1c-active-pr-release`.
- Alle Zeilenanker in diesem Plan sind an dieser Basis gemessen (frischer Klon im Workspace). Der Prod-Checkout p221 @ 19b57f11d6 ist NUR Vorkommnis-Referenz (dort liegen die Guard-Zeilen bei Z.1525–1664 — bewusst NICHT als Anker verwendet, Anker-Hygiene wie in t_56037ffe Gate A Runde 1 beanstandet).
- Prod-Checkout bleibt unberührt; Ausrollung ist ein separater Prod-Wechsel (§7).

## §1 Befund (belegt)

1. `check_respawn_guard` (kanban_db_dispatch.py **Z.1771**, Basis) hält eine ready-Karte, wenn in den letzten 24 h (`_RESPAWN_GUARD_PR_WINDOW = 86400`, **Z.83**) ein Kommentar mit GitHub-PR-URL steht (**Z.1868–1892**).
2. Freigabe NUR via Übergabe-Ereignisse (`assigned` mit from≠to, `changes_requested`, `review_reopened`), strikt nach dem neuesten PR-Kommentar (**Z.1883–1891**), Same-Second-Tie fail-closed.
3. Re-queue-Ereignisse (`status`, `promoted`, `unblocked`, `reclaimed`) stehen nur in der recent_success-Liste (**Z.1858–1864**), NICHT in Abschnitt 4 — die #162-Lücke. Live belegt: t_2ad7df40 wurde 06:16Z reclaimed und blieb gehalten; am 08.10. manuell per doppeltem echten Reassign freigegeben (boardops41, Wirkungsnachweis: Abschluss-Lauf 10956 spawnte 06:32:04Z).
4. Auch ein MERGED-PR löst nicht: PR #138 war 05:27:14Z gemergt (ae35744c), die Karte blieb bis zur manuellen Freigabe gehalten — false positive, Supervisor-Finding `dispatcher-guard-fp-t_2ad7df40-0810.json` (sev=medium), Betreiber-Fix-Richtung: zustandsbasiert statt 24h-Aktivitätsfenster.
5. Register: PR #162 (Re-queue-Freigabe) OPEN/CONFLICTING — Branch ist upstream-basiert, Diff 300+ Dateien vs fork main (Head-Drift, nicht mergebar ohne Neubasis); PR #163 (strikt-nach-Tie) OPEN/BLOCKED gegen fork main. Ihr INHALT wird hier auf der Kern-Linie abgedeckt (§8).

## §2 Zielbild (Verhaltensvertrag)

Eine ready-Karte mit PR-URL-Kommentar im Fenster wird gespawnt, wenn EINE der Freigabe-Bedingungen erfüllt ist — sonst bleibt sie fail-closed gehalten:

- **R1 Re-queue-Freigabe (B1):** ein explizites Re-queue-Ereignis (`status`, `promoted`, `unblocked`, `reclaimed`) STRIKT NACH dem neuesten PR-URL-Kommentar ist ein bewusster „lauf jetzt"-Auftrag und löst das Schloss. Same-Second-Tie bleibt gehalten (fail-closed, Tie-Semantik aus #163, NICHT die schwächere `>=`-Fassung von fork main).
- **R2 Zustands-Freigabe (B2/B3):** sind ALLE im Fenster auf der Karte verlinkten PRs (dedupliziert über Kommentare) laut GitHub im Zustand MERGED oder CLOSED, löst das Schloss — es existiert kein offener verlinkter PR mehr, den ein neuer Lauf duplizieren könnte. Ein EINZIGER offener verlinkter PR hält weiter (eigener Testfall).
- **R3 Fail-closed-Richtung:** ohne Netz-Beweis (API-Fehler, Timeout, keine Anmeldedaten) bleibt das Schloss stehen. Freigabe erfordert Beweis, Nicht-Freigabe ist der sichere Zustand.
- **R4 Unverändert bleiben:** Handoff-Freigabe (bestehendes Verhalten inkl. `_is_handoff_event` fail-closed), default_assignee-Schutz (dessen `assigned`-Events sind nie Handoffs und nie Re-queues), review-lane-Ausnahme, recent_success-Logik, 24h-Fenster als Obergrenze der Zustandsprüfung.

## §3 Lösung

### 3.1 Re-queue-Freigabe (R1)

In Abschnitt 4 (`kanban_db_dispatch.py` **Z.1868–1892**) wird die Ereignis-Abfrage nach dem neuesten PR-URL-Kommentar um die Re-queue-Klassen erweitert und zweistufig ausgewertet:

- Abfrage-Klassen: `'assigned', 'changes_requested', 'review_reopened'` + `'status', 'promoted', 'unblocked', 'reclaimed'`, weiterhin `created_at > ?` (strikte Tie, **Z.1886** unverändert).
- Auswertung: Freigabe, wenn (a) `_is_handoff_event` für eines der Übergabe-Ereignisse wahr ist (bestehender Pfad) ODER (b) eines der Re-queue-Ereignisse vorliegt (deren Art IST der bewusste Re-queue-Auftrag — keine zusätzliche Payload-Prüfung nötig; `kanban.default_assignee` schreibt ausschließlich `assigned`-Events und kann den Pfad (b) daher nie auslösen).
- Konstante `_RESPAWN_GUARD_REQUEUE_KINDS` neben den bestehenden Guard-Konstanten (**Z.74–88**).

### 3.2 Zustandsbasierte MERGED-Freigabe (R2/R3)

- Wenn Abschnitt 4 die Karte sonst halten würde (neuester PR-URL-Kommentar, keine Freigabe aus 3.1), werden ALLE PR-URLs aus ALLEN Kommentaren im Fenster gesammelt (`_RESPAWN_GUARD_PR_URL_RE`, **Z.85**, dedupliziert nach owner/repo/number) und je PR der Zustand erfragt.
- Neuer topical Sibling **`hermes_cli/kanban_pr_state.py`** (facade+siblings-Layout; kanban_db_dispatch bleibt unter der Größenlinie): 
  - `parse_pr_urls(text) -> list[(owner, repo, number)]` (reiner Parser, DI-freundlich),
  - `all_prs_terminal(urls) -> bool` — True nur, wenn JEDE URL MERGED/CLOSED ist; False bei jedem Zweifel (offener PR, API-Fehler, Timeout, fehlende Anmeldung) — R3 fail-closed,
  - Prozess-Cache je URL `{(owner, repo, number): (checked_at, terminal)}`, TTL-Konstante 300 s (B3),
  - Transport: `gh api repos/<owner>/<repo>/pulls/<n> --hostname github.com --jq ...` als Subprozess, Timeout-Konstante 2,5 s (B3: 2–3 s), Muster nach `hermes_cli/kanban_pr_acceptance.py::_api` (**Z.25–37** an der Basis); stderr wird nie persistiert (Z.107-Konvention),
  - DI-Prüfnäht: die konkrete Einzel-PR-Erfrage ist austauschbar (Tests monkeypatchen die Naht, kein Netz in der Suite).
- Verdrahtung: nur auf dem Hold-Pfad von Abschnitt 4 — Karten ohne PR-URL-Kommentar im Fenster zahlen NIEMALS eine API-Zeit (B3); Taktlast = Anzahl aktuell gehaltener Karten × 1 Aufruf je URL je TTL-Fenster.

### 3.3 Konstanten (neben Z.74–88)

`_RESPAWN_GUARD_REQUEUE_KINDS`, `_PR_STATE_CACHE_TTL = 300`, `_PR_STATE_PROBE_TIMEOUT = 2.5`. Keine neuen `HERMES_*`-Env-Variablen, kein config-Surface (Kernel-Konvention der Guard-Konstanten).

## §4 Schutzklassen-Dreiklang (was der Fix NICHT schwächt)

1. Doppel-PR-Schutz: ein offener verlinkter PR hält WEITER (R2/B2 — schärfer als das reine Zeitfenster, weil der Zustand zählt); Unbekannt-Zustand hält (R3).
2. Bewusste Reihen-Freigabe: nur echte Re-queue-Ereignisse (R1) oder Übergabe-Ereignisse (bestehend) heben vorzeitig.
3. Fail-closed-Ties: Same-Second bleibt gehalten (Z.1884–1886 unverändert, auch für die neuen Klassen).

## §5 Dateiliste

| Datei | Änderung |
|---|---|
| `hermes_cli/kanban_db_dispatch.py` | Abschnitt 4: Re-queue-Klassen in der Ereignisabfrage + zweistufige Auswertung; MERGED-Freigabe über den Sibling auf dem Hold-Pfad; Docstring (Z.1774–1791) + Abschnitt-4-Kommentar aktualisiert |
| `hermes_cli/kanban_pr_state.py` | NEU: URL-Parser, Zustands-Erfrage mit Cache/Timeout/fail-closed, DI-Naht |
| `tests/hermes_cli/test_kanban_active_pr_release.py` | NEU: Suite §6 |

Keine Änderungen an: kanban_db.py, kanban_ops.py, plugins.py, gateway/* (die tick-seitige Verdrahtung liegt in kanban_db_dispatch selbst; kanban_ops gibt die Tick-Zusammenfassung unverändert weiter).

## §6 Testplan (Verhaltensverträge, keine Snapshot-Tests)

Neue Suite `tests/hermes_cli/test_kanban_active_pr_release.py`, Muster der bestehenden Guard-Suiten (kanban_home-Fixture, `dispatch_once(dry_run=True)`):

- T1 R1 positiv: PR-Kommentar, danach `unblocked` (+1 s) → Freigabe (Karte im spawned-Bucket).
- T2 Tie negativ: Re-queue-Ereignis in derselben Sekunde wie der PR-Kommentar → gehalten (fail-closed).
- T3 Negativ-Basis: PR-Kommentar ohne Folgereignis → gehalten.
- T4 default_assignee negativ: `assigned`-Event mit source=kanban.default_assignee nach dem PR-Kommentar → gehalten (weder Handoff noch Re-queue).
- T5 R2 positiv: zwei verlinkte PRs, Erfrage meldet beide terminal → Freigabe.
- T6 R2 Richtung: zwei verlinkte PRs, einer offen → gehalten (B2-Zusatzfall).
- T7 R3 negativ: Erfrage wirft/timeoutet → gehalten (fail-closed ohne Netz-Beweis).
- T8 Anker-Stabilität: PR gemergt, danach nur URL-lose Kommentare → weiterhin Freigabe (URL-lose Kommentare reankern nicht, Regex Z.85).
- T9 Regression: Handoff-Freigabe (echtes from≠to-assigned) funktioniert unverändert.
- T10 Cache: zweiter Guard-Aufruf innerhalb der TTL ruft die Erfrage-Naht nicht erneut auf (Zähler an der Naht).
- Ziel-Suiten mit Baseline-Vergleich an der PR-Basis (Worktree-gegen-Basis-Differenz, Full-Suite-Baseline-Regel aus cubolt-hermes-agent-fix-flow): `test_kanban_review_lifecycle.py`, `test_kanban_db.py`, `test_kanban_ghost_reap.py` (Schwester), plus `ruff check` über die geänderten Dateien.

## §7 Ausroll-Weg (bewusst ausgekoppelt)

Ausrollung auf die Live-Linie (p221 @ 19b57f11d6) = Prod-Wechsel am Hermes-Backend → eigene Folge-Karte mit Owner-Freigabe, Ausführung über die CTO-Lane mit Backup + Neustart-Protokoll; kein git reset/checkout auf dem Prod-Checkout (Owner-Anordnung 23.09.2026). Danach Live-Regression: eine fertige Karte mit gemergtem PR wird im nächsten Tick gezogen — kein Handgriff (Lebend-Probe-Klasse t_2ad7df40).

## §8 Merge-Ordnung und Register

- VOR Gate B Abstimmung mit t_1fc1b854 (PR #172, dieselben Dateien kanban_db_dispatch.py): wer zuerst durch beide Gates ist, merged zuerst (sha-guardiert, `--match-head-commit`); der andere rebasiert auf den neuen Tip, Union-Auflösung im Guard-Abschnitt (etabliertes Muster, Hotspot-Kommentar t_56037ffe 05:48).
- Register-PRs #162/#163 (base fork main) werden NACH der Ausrollung geschlossen — ihr Inhalt ist durch R1/R2 abgedeckt; sonst leben drei Fassungen derselben Regel. Schließ-Entscheid beim Register-Verantwortlichen (Folge-Karte, nicht Teil dieses Bau-Schnitts).

## §9 Entscheidungen (durch Planer-Statement 08.10. abgedeckt)

- Design-Frage (API im Takt vs. board-seitiges Ereignis): **Variante 1** — Planer-Entscheid, Begründung im Statement (§ Design-Frage). Variante 2 optional als Beschleuniger, keine Voraussetzung.
- Owner-Frage: KEINE vor dem Bau; einzige Owner-Freigabe ist die Ausrollungs-Karte (§7).
- Doppelbau-Risiken: nur §8 (beide benannt).
