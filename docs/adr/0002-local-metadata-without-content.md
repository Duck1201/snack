---
status: accepted
---

# Keep data local and retain no prompt content

SNACK will make no runtime network calls, collect no telemetry, and persist only metadata needed for usage analysis, forecasting, and calibration. Prompt/response text, project paths/titles, and credentials are forbidden from the database, spool, logs, snapshots, and exports; optional prompt categorization processes text ephemerally on-device after explicit consent and stores only approved non-reversible aggregates. This sacrifices semantic/content-based prediction and community baselines in exchange for a narrow privacy boundary, simpler operation, and user trust; explicit export is the only product path for records to leave local storage.
