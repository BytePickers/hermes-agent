# Plan: Port the mic-recorder noiseSuppression fix to upstream main

## Problem
Browser noiseSuppression gate-chops speech in the desktop chat composer's
voice-note recorder: the speech onset reaches the STT recognizer fragmented
(fragments, shifted onset, low confidence). The recorder itself proved robust
to noise and level.

## Root cause
apps/desktop/src/app/chat/composer/hooks/use-mic-recorder.ts requests
`audio: { echoCancellation: true, noiseSuppression: true }` (no
autoGainControl) at the current main tip (8ac5c74432d1, around line 289).

## Proposed change (one commit on a fresh main branch)
1. use-mic-recorder.ts: request
   `audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: true }`
   plus a short factual comment above the getUserMedia call
   (echoCancellation stays on, autoGainControl stabilizes the level).
2. use-mic-recorder.test.tsx: keep the existing level-meter suite untouched
   and add the constraint-contract case to it (asserts the exact getUserMedia
   audio constraints captured on start).

## Evidence
The same fix runs in our internal deployment line (verified head, CI pass,
independent review) and is rebased here onto current main; the hook file was
moved by the October 6 streaming commit, so the change is re-applied at the
new location rather than copied.

## Test plan
- existing level-meter suite stays green;
- added constraint-contract case passes;
- diff against the base head contains only the constraint line, the comment
  and the added test case.

## Risks
autoGainControl changes the level path intentionally (stabilizes the input
level); echoCancellation stays on, so no echo regression. No audio leaves
the machine; the constraints only affect the local browser session.

## Rollout
None on our side. Upstream merge is the maintainer's decision; CI on a
first-time contribution starts after a maintainer "Approve & run".
