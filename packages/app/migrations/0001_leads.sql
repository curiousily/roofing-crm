CREATE TABLE leads (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  prop_id INTEGER,
  permit_number TEXT,
  address TEXT NOT NULL,
  latitude REAL,
  longitude REAL,
  owner_name TEXT,
  mailing_address TEXT,
  roof_age_years INTEGER,
  roof_age_anchor TEXT,
  roof_age_confidence TEXT,
  permit_state TEXT,
  years_open INTEGER,
  contractor_name TEXT,
  bbb_rating TEXT,
  signals TEXT NOT NULL,
  status TEXT NOT NULL,
  priority TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  next_action_on TEXT,
  dataset_root_cid TEXT NOT NULL,
  dataset_build_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX leads_by_workspace ON leads (workspace_id, updated_at);
CREATE UNIQUE INDEX leads_by_property ON leads (workspace_id, prop_id) WHERE prop_id IS NOT NULL;
CREATE UNIQUE INDEX leads_by_permit ON leads (workspace_id, permit_number)
  WHERE prop_id IS NULL AND permit_number IS NOT NULL;

CREATE TABLE lead_activities (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL,
  at TEXT NOT NULL
);

CREATE INDEX activities_by_lead ON lead_activities (lead_id, seq);
